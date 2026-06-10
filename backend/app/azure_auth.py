"""Azure AD / EntraID JWT validation for the SPA flow.

The React frontend acquires tokens via MSAL.js and passes them as
``Authorization: Bearer <token>`` on every API request. This module
validates the JWT and returns the caller's identity (oid + name + email
+ roles), which the rest of the app uses to look up the in-app
``User`` row.

Pattern matches OATS / gshield:
- JWKS keys cached for 24 hours, force-refreshed on unknown ``kid``.
- Accept both v1 (sts.windows.net) and v2 (login.microsoftonline.com/v2.0)
  issuers — Azure AD emits either depending on the app registration's
  access-token version.
- Accept both the bare ``client_id`` and ``api://{client_id}`` audience
  forms.
- Graph-token fallback (unverified decode but with tenant-issuer check)
  while ``api_scope`` is empty — Microsoft doesn't publish signing keys
  for Graph tokens, so verification fails until the app registration
  exposes a custom scope and the frontend asks for it.
- ``DT_DEV_SKIP_JWT_VERIFY=1`` short-circuits everything for local dev.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
from typing import Any

import httpx
from fastapi import HTTPException, Request
from jose import jwt
from jose.exceptions import ExpiredSignatureError, JWTClaimsError, JWTError

from .settings import settings

logger = logging.getLogger(__name__)

_JWKS_TTL_SECONDS = 24 * 60 * 60


def _jwks_url() -> str:
    return f"https://login.microsoftonline.com/{settings.azure_ad_tenant_id}/discovery/v2.0/keys"


def _valid_issuers() -> list[str]:
    tid = settings.azure_ad_tenant_id
    return [
        f"https://sts.windows.net/{tid}/",
        f"https://login.microsoftonline.com/{tid}/v2.0",
    ]


def _valid_audiences() -> list[str]:
    cid = settings.azure_ad_client_id
    if not cid:
        return []
    return [cid, f"api://{cid}"]


class _JWKSKeyCache:
    """Thread-safe JWKS cache. 24-hour TTL, force-refresh on unknown kid."""

    def __init__(self) -> None:
        self._keys: list[dict[str, Any]] = []
        self._fetched_at: float = 0.0
        self._lock = threading.Lock()

    def _refresh_locked(self) -> None:
        now = time.time()
        if self._keys and (now - self._fetched_at) < _JWKS_TTL_SECONDS:
            return
        if not settings.azure_ad_tenant_id:
            # Fail fast — otherwise every request hammers
            # https://login.microsoftonline.com//discovery/v2.0/keys (404)
            # and stacks up behind the cache lock.
            raise HTTPException(
                status_code=503,
                detail="Azure AD tenant id not configured (DT_AZURE_AD_TENANT_ID)",
            )
        try:
            response = httpx.get(_jwks_url(), timeout=10)
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPError:
            logger.exception("Failed to fetch JWKS")
            if not self._keys:
                raise HTTPException(status_code=401, detail="Unable to fetch token signing keys")
            return
        self._keys = data.get("keys", []) or []
        self._fetched_at = now

    def get(self, kid: str) -> dict[str, Any] | None:
        with self._lock:
            self._refresh_locked()
            for key in self._keys:
                if key.get("kid") == kid:
                    return key
            # Unknown kid — keys may have rotated, force a refresh.
            self._fetched_at = 0.0
            self._refresh_locked()
            for key in self._keys:
                if key.get("kid") == kid:
                    return key
            return None

    def all_keys(self) -> list[dict[str, Any]]:
        with self._lock:
            self._refresh_locked()
            return list(self._keys)


_jwks_cache = _JWKSKeyCache()


def _extract_bearer(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = auth[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty access token")
    return token


def _decode_unverified(token: str) -> dict[str, Any]:
    """Base64-decode the JWT payload without checking the signature."""
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    try:
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return {}


def _decode_verified(token: str) -> dict[str, Any]:
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"Malformed token header: {exc}") from exc
    kid = header.get("kid")
    if not kid:
        raise HTTPException(status_code=401, detail="Token header missing kid")
    key = _jwks_cache.get(kid)
    if key is None:
        raise HTTPException(status_code=401, detail="Unable to find signing key for token")
    try:
        payload = jwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            audience=_valid_audiences() or None,
            options={"verify_iss": False, "verify_aud": bool(_valid_audiences())},
        )
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except JWTClaimsError as exc:
        raise HTTPException(status_code=401, detail=f"Token claims invalid: {exc}") from exc
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}") from exc

    expected_issuers = _valid_issuers()
    if expected_issuers and payload.get("iss") not in expected_issuers:
        raise HTTPException(status_code=401, detail="Token issuer mismatch")
    return payload


def _decode_best_effort(token: str) -> dict[str, Any]:
    """Try verified decode; fall back to unverified for Graph tokens.

    Graph access tokens are signed with keys Microsoft doesn't publish,
    so verified decode fails. Until the Terraform module exposes
    ``user_impersonation`` and ``DT_AZURE_AD_API_SCOPE`` is set, fall
    back to an unverified decode with a tenant-issuer sanity check —
    matches the OATS pattern.
    """
    try:
        return _decode_verified(token)
    except HTTPException:
        if settings.azure_ad_api_scope:
            raise
        payload = _decode_unverified(token)
        if not payload:
            raise HTTPException(status_code=401, detail="Malformed token")
        tid = settings.azure_ad_tenant_id
        if tid and tid not in payload.get("iss", ""):
            raise HTTPException(status_code=401, detail="Token issuer not from expected tenant")
        return payload


def get_access_token(request: Request) -> str:
    """Extract the Bearer token from the request, raising 401 if absent."""
    return _extract_bearer(request)


def get_user_context_from_token(token: str) -> dict[str, Any]:
    """Resolve a user context from a raw token string.

    Same shape as :func:`get_user_context` but skips the Bearer-header
    extraction step. Use this for endpoints whose token can't arrive in
    the ``Authorization`` header — currently SSE, since EventSource has
    no way to set request headers from the browser. The frontend passes
    the token as a query string param instead and the route handler
    validates it via this function.
    """
    if not token:
        raise HTTPException(status_code=401, detail="Empty access token")

    if settings.dev_skip_jwt_verify:
        payload = _decode_unverified(token)
    else:
        payload = _decode_best_effort(token)

    user_id = payload.get("oid", "")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token does not contain a user identifier (oid)")

    return {
        "token": token,
        "user_id": user_id,
        "name": payload.get("name", "") or "",
        "email": (payload.get("preferred_username") or payload.get("email") or "") or "",
        "roles": [r for r in (payload.get("roles") or []) if isinstance(r, str)],
    }


def get_user_context(request: Request) -> dict[str, Any]:
    """Return ``{token, user_id, name, email, roles}`` for the caller.

    ``user_id`` is the Azure AD ``oid`` — the stable, tenant-scoped
    object id. This is the database-isolation key. Raises 401 if the
    token is missing, malformed, expired, or has no ``oid`` claim.
    """
    return get_user_context_from_token(_extract_bearer(request))



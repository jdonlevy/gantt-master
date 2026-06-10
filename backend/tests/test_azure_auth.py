"""Regression tests for malformed-token and missing-tenant auth paths.

Before these guards, a garbage Bearer token raised ``jose.JWTError`` from
``jwt.get_unverified_header`` outside the catch block, surfacing as a 500.
And an empty ``DT_AZURE_AD_TENANT_ID`` produced a malformed JWKS URL
(``https://login.microsoftonline.com//discovery/v2.0/keys``) that 404'd
on every request and serialised behind the cache lock.
"""

import pytest
from fastapi import HTTPException

from app import azure_auth
from app.azure_auth import _JWKSKeyCache, get_user_context_from_token


def test_garbage_token_returns_401(monkeypatch):
    monkeypatch.setattr(azure_auth.settings, "azure_ad_tenant_id", "tenant-x")
    monkeypatch.setattr(azure_auth.settings, "azure_ad_api_scope", "")
    monkeypatch.setattr(azure_auth.settings, "dev_skip_jwt_verify", False)

    with pytest.raises(HTTPException) as exc:
        get_user_context_from_token("not-a-jwt")
    assert exc.value.status_code == 401


def test_structured_but_invalid_token_returns_401(monkeypatch):
    monkeypatch.setattr(azure_auth.settings, "azure_ad_tenant_id", "tenant-x")
    monkeypatch.setattr(azure_auth.settings, "azure_ad_api_scope", "api-scope")
    monkeypatch.setattr(azure_auth.settings, "dev_skip_jwt_verify", False)

    # Header is base64'd JSON but the body is unreadable — jose raises
    # JWTError("Error decoding token headers.") from get_unverified_header.
    token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.x"
    with pytest.raises(HTTPException) as exc:
        get_user_context_from_token(token)
    assert exc.value.status_code == 401


def test_empty_tenant_fails_fast_on_jwks(monkeypatch):
    monkeypatch.setattr(azure_auth.settings, "azure_ad_tenant_id", "")

    cache = _JWKSKeyCache()
    with pytest.raises(HTTPException) as exc:
        cache.get("any-kid")
    assert exc.value.status_code == 503
    assert "tenant" in exc.value.detail.lower()

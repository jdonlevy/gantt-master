"""Tests for the presence tracking endpoints.

Covers:
- PUT /api/presence: sets an entry keyed by tabId or user.id.
- GET /api/presence/{slug}: returns active editors, excludes caller,
  excludes stale entries, excludes other slugs.
- DELETE /api/presence: removes the caller's entry.
- GET /api/me: returns Azure AD user identity.
- TTL expiry: stale entries are purged on write.
"""

import importlib
import time
import uuid

import pytest

from app.dependencies import get_current_user
from app.main import app
from app.models import Role, User

presence_module = importlib.import_module("app.routers.presence")


# ── helpers ────────────────────────────────────────────────────────────────────

def _make_user(display_name="Alice", email="alice@example.com"):
    u = User()
    u.id = uuid.uuid4()
    u.display_name = display_name
    u.email = email
    u.role = Role.editor
    return u


def _override_user(user: User):
    async def _dep():
        return user
    return _dep


def _clear_store():
    presence_module._presence.clear()


# ── PUT /api/presence ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_set_presence_uses_user_display_name(client):
    """Identity in the store comes from the authenticated User's display_name."""
    _clear_store()
    user = _make_user(display_name="Alice", email="alice@example.com")
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        resp = await client.put(
            "/api/presence",
            json={"slug": "board", "barId": "section-1", "tabId": "tab-abc"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

        entry = presence_module._presence.get("tab-abc")
        assert entry is not None
        assert entry["displayName"] == "Alice"
        assert entry["accountId"] == str(user.id)
        assert entry["slug"] == "board"
        assert entry["barId"] == "section-1"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_set_presence_falls_back_to_email(client):
    """When display_name is None, email is used as the display name."""
    _clear_store()
    user = _make_user(display_name=None, email="bob@example.com")
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        resp = await client.put(
            "/api/presence",
            json={"slug": "board", "barId": "s1", "tabId": "tab-bob"},
        )
        assert resp.status_code == 200
        entry = presence_module._presence.get("tab-bob")
        assert entry["displayName"] == "bob@example.com"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_set_presence_uses_user_id_when_no_tab_id(client):
    """When tabId is omitted the entry is keyed by str(user.id)."""
    _clear_store()
    user = _make_user()
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        resp = await client.put(
            "/api/presence",
            json={"slug": "board", "barId": "s1"},
        )
        assert resp.status_code == 200
        assert str(user.id) in presence_module._presence
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── GET /api/presence/{slug} ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_presence_excludes_caller_by_tab_id(client):
    """The caller's own entry (matched by tabId) is never returned."""
    _clear_store()
    presence_module._presence["tab-me"] = {
        "accountId": "me", "displayName": "Me", "avatarUrl": None,
        "slug": "board", "barId": "s1", "updated_at": time.time(),
    }
    presence_module._presence["tab-other"] = {
        "accountId": "other", "displayName": "Other", "avatarUrl": None,
        "slug": "board", "barId": "s2", "updated_at": time.time(),
    }

    resp = await client.get("/api/presence/board?tabId=tab-me")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["displayName"] == "Other"


@pytest.mark.asyncio
async def test_get_presence_excludes_caller_by_user_id(client):
    """When tabId is absent, the caller is excluded by str(user.id)."""
    _clear_store()
    user = _make_user()
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        presence_module._presence[str(user.id)] = {
            "accountId": str(user.id), "displayName": "Me", "avatarUrl": None,
            "slug": "board", "barId": "s1", "updated_at": time.time(),
        }
        presence_module._presence["other-key"] = {
            "accountId": "other", "displayName": "Other", "avatarUrl": None,
            "slug": "board", "barId": "s2", "updated_at": time.time(),
        }

        resp = await client.get("/api/presence/board")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["displayName"] == "Other"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_get_presence_excludes_other_slugs(client):
    """Entries for a different dashboard slug are not returned."""
    _clear_store()
    presence_module._presence["tab-a"] = {
        "accountId": "a", "displayName": "A", "avatarUrl": None,
        "slug": "board-one", "barId": "s1", "updated_at": time.time(),
    }
    presence_module._presence["tab-b"] = {
        "accountId": "b", "displayName": "B", "avatarUrl": None,
        "slug": "board-two", "barId": "s1", "updated_at": time.time(),
    }

    resp = await client.get("/api/presence/board-one?tabId=tab-caller")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["displayName"] == "A"


@pytest.mark.asyncio
async def test_get_presence_excludes_stale_entries(client):
    """Entries older than PRESENCE_TTL_SECS are not returned."""
    _clear_store()
    presence_module._presence["tab-fresh"] = {
        "accountId": "f", "displayName": "Fresh", "avatarUrl": None,
        "slug": "board", "barId": "s1", "updated_at": time.time(),
    }
    presence_module._presence["tab-stale"] = {
        "accountId": "s", "displayName": "Stale", "avatarUrl": None,
        "slug": "board", "barId": "s2",
        "updated_at": time.time() - presence_module.PRESENCE_TTL_SECS - 1,
    }

    resp = await client.get("/api/presence/board?tabId=tab-caller")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["displayName"] == "Fresh"


@pytest.mark.asyncio
async def test_get_presence_returns_bar_id(client):
    """The barId field is returned so the frontend can highlight the right element."""
    _clear_store()
    presence_module._presence["tab-editor"] = {
        "accountId": "e", "displayName": "Ed", "avatarUrl": None,
        "slug": "board", "barId": "section-42", "updated_at": time.time(),
    }

    resp = await client.get("/api/presence/board?tabId=tab-caller")
    assert resp.status_code == 200
    assert resp.json()[0]["barId"] == "section-42"


# ── DELETE /api/presence ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_clear_presence_removes_entry_by_tab_id(client):
    """DELETE /presence?tabId=... removes the matching entry."""
    _clear_store()
    presence_module._presence["tab-del"] = {
        "accountId": "d", "displayName": "Del", "avatarUrl": None,
        "slug": "board", "barId": "s1", "updated_at": time.time(),
    }

    resp = await client.delete("/api/presence?tabId=tab-del")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert "tab-del" not in presence_module._presence


@pytest.mark.asyncio
async def test_clear_presence_removes_entry_by_user_id(client):
    """DELETE /presence without tabId removes the entry keyed by user.id."""
    _clear_store()
    user = _make_user()
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        presence_module._presence[str(user.id)] = {
            "accountId": str(user.id), "displayName": "Me", "avatarUrl": None,
            "slug": "board", "barId": "s1", "updated_at": time.time(),
        }

        resp = await client.delete("/api/presence")
        assert resp.status_code == 200
        assert str(user.id) not in presence_module._presence
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_clear_presence_missing_entry_is_ok(client):
    """DELETE is idempotent — clearing a non-existent entry doesn't error."""
    _clear_store()
    resp = await client.delete("/api/presence?tabId=tab-nonexistent")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


# ── GET /api/me ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_me_returns_user_identity(client):
    """Returns accountId (user.id), displayName, and avatarUrl (None)."""
    user = _make_user(display_name="Dana", email="dana@example.com")
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        resp = await client.get("/api/me")
        assert resp.status_code == 200
        data = resp.json()
        assert data["accountId"] == str(user.id)
        assert data["displayName"] == "Dana"
        assert data["avatarUrl"] is None
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_get_me_falls_back_to_email(client):
    """When display_name is None, email is used as displayName."""
    user = _make_user(display_name=None, email="eve@example.com")
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        resp = await client.get("/api/me")
        assert resp.status_code == 200
        assert resp.json()["displayName"] == "eve@example.com"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_get_me_unknown_when_no_identity(client):
    """When both display_name and email are None, falls back to 'Unknown'."""
    user = _make_user(display_name=None, email=None)
    app.dependency_overrides[get_current_user] = _override_user(user)
    try:
        resp = await client.get("/api/me")
        assert resp.status_code == 200
        assert resp.json()["displayName"] == "Unknown"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── TTL / stale purge ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stale_entries_purged_on_set(client):
    """_purge_stale is called during PUT so the store doesn't grow unbounded."""
    _clear_store()
    presence_module._presence["tab-old"] = {
        "accountId": "old", "displayName": "Old", "avatarUrl": None,
        "slug": "board", "barId": "s0",
        "updated_at": time.time() - presence_module.PRESENCE_TTL_SECS - 5,
    }

    resp = await client.put(
        "/api/presence",
        json={"slug": "board", "barId": "s1", "tabId": "tab-new"},
    )
    assert resp.status_code == 200
    assert "tab-old" not in presence_module._presence
    assert "tab-new" in presence_module._presence

import uuid

import pytest


@pytest.mark.asyncio
@pytest.mark.real_auth
async def test_create_dependency_override_requires_auth(client):
    """With the auth stub opted out the real require_auth runs; unauthenticated
    requests should be rejected with 401 before any DB work happens."""
    response = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "fix-1",
            "toId": "fix-2",
            "fromType": "fix",
            "toType": "fix",
        },
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_create_dependency_override_rejects_invalid_dashboard_id(client, fake_session):
    response = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "fix-1",
            "toId": "fix-2",
            "fromType": "fix",
            "toType": "fix",
            "dashboardId": "not-a-uuid",
        },
    )
    assert response.status_code == 422
    assert "dashboardId" in response.text


@pytest.mark.asyncio
async def test_create_dependency_override_success(client, fake_session):
    response = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "fix-1",
            "toId": "fix-2",
            "fromType": "fix",
            "toType": "fix",
            "dashboardId": "00000000-0000-0000-0000-000000000001",
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["fromId"] == "fix-1"
    assert payload["toId"] == "fix-2"
    assert payload["fromType"] == "fix"
    assert payload["toType"] == "fix"
    assert payload["dashboardId"] == "00000000-0000-0000-0000-000000000001"
    assert uuid.UUID(payload["id"])  # well-formed UUID


@pytest.mark.asyncio
async def test_create_dependency_override_rejects_self_link(client, fake_session):
    response = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "epic-1",
            "toId": "epic-1",
            "fromType": "epic",
            "toType": "epic",
        },
    )

    assert response.status_code == 422
    assert "itself" in response.text.lower()


@pytest.mark.asyncio
async def test_create_dependency_override_rejects_story_nodes(client, fake_session):
    response = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "story-1",
            "toId": "epic-1",
            "fromType": "story",
            "toType": "epic",
        },
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_dependency_override_duplicate_returns_409(client, fake_session):
    payload = {
        "fromId": "epic-1",
        "toId": "epic-2",
        "fromType": "epic",
        "toType": "epic",
        "dashboardId": "00000000-0000-0000-0000-000000000001",
    }

    first = await client.post("/api/overrides/dependency", json=payload)
    assert first.status_code == 201

    second = await client.post("/api/overrides/dependency", json=payload)
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_create_dependency_override_rejects_reverse_link(client, fake_session):
    forward = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "epic-a",
            "toId": "epic-b",
            "fromType": "epic",
            "toType": "epic",
            "dashboardId": "00000000-0000-0000-0000-000000000001",
        },
    )
    assert forward.status_code == 201

    reverse = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "epic-b",
            "toId": "epic-a",
            "fromType": "epic",
            "toType": "epic",
            "dashboardId": "00000000-0000-0000-0000-000000000001",
        },
    )
    assert reverse.status_code == 409
    assert "reverse" in reverse.text.lower()


@pytest.mark.asyncio
async def test_delete_dependency_override_success(client, fake_session):
    created = await client.post(
        "/api/overrides/dependency",
        json={
            "fromId": "epic-1",
            "toId": "epic-2",
            "fromType": "epic",
            "toType": "epic",
        },
    )
    assert created.status_code == 201
    override_id = created.json()["id"]

    response = await client.delete(f"/api/overrides/dependency/{override_id}")
    assert response.status_code == 204
    assert fake_session.dependency_overrides == []


@pytest.mark.asyncio
async def test_delete_dependency_override_missing_returns_404(client, fake_session):
    response = await client.delete(
        "/api/overrides/dependency/00000000-0000-0000-0000-000000000099"
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_dependency_override_invalid_id_returns_404(client, fake_session):
    response = await client.delete("/api/overrides/dependency/not-a-uuid")
    assert response.status_code == 404

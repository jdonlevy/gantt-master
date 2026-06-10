import pytest


@pytest.mark.asyncio
@pytest.mark.real_auth
async def test_fix_version_override_requires_auth(client):
    """With the auth stub opted out the real require_auth runs; unauthenticated
    requests should be rejected with 401."""
    response = await client.post(
        "/api/overrides/fix-version",
        json={"fixVersionId": "fix-1", "uatStart": "2026-02-10"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_fix_version_override_rejects_invalid_dashboard_id(client, fake_session):
    response = await client.post(
        "/api/overrides/fix-version",
        json={
            "fixVersionId": "fix-1",
            "dashboardId": "not-a-uuid",
            "uatStart": "2026-02-10",
        },
    )
    assert response.status_code == 422
    assert "dashboardId" in response.text


@pytest.mark.asyncio
async def test_fix_version_override_upsert(client, fake_session):
    response = await client.post(
        "/api/overrides/fix-version",
        json={
            "fixVersionId": "fix-1",
            "dashboardId": "00000000-0000-0000-0000-000000000001",
            "uatStart": "2026-02-10",
            "uatEnd": "2026-02-12",
            "liveStart": "2026-03-01",
            "liveEnd": "2026-03-05",
            "notes": "Ready",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["uatStart"] == "2026-02-10"
    assert payload["liveEnd"] == "2026-03-05"

    response = await client.post(
        "/api/overrides/fix-version",
        json={
            "fixVersionId": "fix-1",
            "dashboardId": "00000000-0000-0000-0000-000000000001",
            "uatStart": "2026-02-11",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["uatStart"] == "2026-02-11"


@pytest.mark.asyncio
async def test_fix_version_override_rejects_uat_start_after_end(client, fake_session):
    response = await client.post(
        "/api/overrides/fix-version",
        json={
            "fixVersionId": "fix-1",
            "uatStart": "2026-02-20",
            "uatEnd": "2026-02-10",
        },
    )

    assert response.status_code == 422
    assert "UAT start" in response.text


@pytest.mark.asyncio
async def test_fix_version_override_rejects_live_start_after_end(client, fake_session):
    response = await client.post(
        "/api/overrides/fix-version",
        json={
            "fixVersionId": "fix-2",
            "liveStart": "2026-03-10",
            "liveEnd": "2026-03-01",
        },
    )

    assert response.status_code == 422
    assert "Live start" in response.text


@pytest.mark.asyncio
async def test_fix_version_override_allows_equal_start_and_end(client, fake_session):
    response = await client.post(
        "/api/overrides/fix-version",
        json={
            "fixVersionId": "fix-3",
            "uatStart": "2026-02-10",
            "uatEnd": "2026-02-10",
        },
    )

    assert response.status_code == 200

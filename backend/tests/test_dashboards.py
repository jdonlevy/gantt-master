import uuid
from datetime import datetime, timezone
import importlib

import pytest

from app.database import get_session
from app.main import app
from app.models import Dashboard, DashboardPanel
from helpers import FakeSession


@pytest.mark.asyncio
async def test_dashboard_create_defaults(client, monkeypatch):
    session = FakeSession()

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session

    response = await client.post("/api/dashboards", json={"title": "Outdoor Weekly Update"})
    app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["slug"] == "outdoor-weekly-update"
    assert len(payload["panels"]) == 4
    assert payload["filters"]["projects"] == []


@pytest.mark.asyncio
async def test_dashboard_unique_slug(client, monkeypatch):
    existing = Dashboard(
        id=uuid.uuid4(),
        slug="outdoor-weekly-update",
        title="Existing",
        filters_json={},
        updated_at=datetime.now(timezone.utc),
    )

    session = FakeSession(dashboards=[existing])

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.post("/api/dashboards", json={"title": "Outdoor Weekly Update"})
    app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["slug"] == "outdoor-weekly-update-2"


@pytest.mark.asyncio
async def test_dashboard_panel_update(client, monkeypatch):
    dashboard_id = uuid.uuid4()
    dashboard = Dashboard(
        id=dashboard_id,
        slug="gpo",
        title="GPO",
        filters_json={},
        updated_at=datetime.now(timezone.utc),
    )
    panel = DashboardPanel(
        id=uuid.uuid4(),
        dashboard_id=dashboard_id,
        type="rich_text",
        title="Weekly update",
        row=1,
        column=1,
        width=12,
        height=3,
        updated_at=datetime.now(timezone.utc),
    )
    session = FakeSession(dashboards=[dashboard], panels=[panel])

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.put(
        f"/api/dashboards/{dashboard.slug}/panels/{panel.id}",
        json={"title": "Weekly update revised", "width": 8},
    )
    app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["title"] == "Weekly update revised"
    assert payload["width"] == 8


@pytest.mark.asyncio
async def test_dashboard_panel_invalid_id(client, monkeypatch):
    dashboard = Dashboard(
        id=uuid.uuid4(),
        slug="gpo",
        title="GPO",
        filters_json={},
        updated_at=datetime.now(timezone.utc),
    )
    session = FakeSession(dashboards=[dashboard])

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.put(
        "/api/dashboards/gpo/panels/not-a-uuid",
        json={"title": "Bad"},
    )
    app.dependency_overrides.clear()

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_dashboard_create_with_folder(client, monkeypatch):
    session = FakeSession()

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.post(
        "/api/dashboards",
        json={"title": "Radio Weekly", "folder": "Radio"},
    )
    app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["folder"] == "Radio"
    assert payload["slug"] == "radio-weekly"


@pytest.mark.asyncio
async def test_dashboard_create_without_folder(client, monkeypatch):
    session = FakeSession()

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.post("/api/dashboards", json={"title": "No Folder"})
    app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["folder"] is None


@pytest.mark.asyncio
async def test_dashboard_update_folder(client, monkeypatch):
    dashboard = Dashboard(
        id=uuid.uuid4(),
        slug="move-me",
        title="Move Me",
        folder="Radio",
        filters_json={},
        updated_at=datetime.now(timezone.utc),
    )
    session = FakeSession(dashboards=[dashboard])

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.put("/api/dashboards/move-me", json={"folder": "AI"})
    app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["folder"] == "AI"


@pytest.mark.asyncio
async def test_dashboard_clear_folder(client, monkeypatch):
    dashboard = Dashboard(
        id=uuid.uuid4(),
        slug="clear-me",
        title="Clear Me",
        folder="Radio",
        filters_json={},
        updated_at=datetime.now(timezone.utc),
    )
    session = FakeSession(dashboards=[dashboard])

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.put("/api/dashboards/clear-me", json={"folder": None})
    app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["folder"] is None


@pytest.mark.asyncio
async def test_dashboard_delete(client, monkeypatch):
    dashboard_id = uuid.uuid4()
    dashboard = Dashboard(
        id=dashboard_id,
        slug="delete-me",
        title="Delete Me",
        filters_json={},
        updated_at=datetime.now(timezone.utc),
    )
    panel = DashboardPanel(
        id=uuid.uuid4(),
        dashboard_id=dashboard_id,
        type="rich_text",
        title="Weekly update",
        row=1,
        column=1,
        width=12,
        height=3,
        updated_at=datetime.now(timezone.utc),
    )
    session = FakeSession(dashboards=[dashboard], panels=[panel])

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.delete("/api/dashboards/delete-me")
    app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert session.dashboards == []
    assert session.panels == []

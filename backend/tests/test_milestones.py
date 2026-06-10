from datetime import date

import pytest

from app.database import get_session
from app.main import app
from app.models import Milestone
from helpers import FakeSession


@pytest.mark.asyncio
async def test_milestones_crud(client):
    session = FakeSession()

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session

    create_response = await client.post(
        "/api/milestones",
        json={
            "label": "Launch",
            "date": "2026-03-01",
            "color": "#22c55e",
            "dashboardId": "00000000-0000-0000-0000-000000000001",
        },
    )
    assert create_response.status_code == 200
    created = create_response.json()

    update_response = await client.put(
        f"/api/milestones/{created['id']}",
        json={"label": "Launch Updated", "date": "2026-03-02", "color": "#f97316"},
    )
    assert update_response.status_code == 200
    updated = update_response.json()
    assert updated["label"] == "Launch Updated"
    assert updated["date"] == "2026-03-02"

    delete_response = await client.delete(f"/api/milestones/{created['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json() == {"ok": True}

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_milestone_not_found(client):
    session = FakeSession(milestones=[Milestone(label="Existing", date=date(2026, 1, 1), color="#111")])

    async def override_session():
        yield session

    app.dependency_overrides[get_session] = override_session
    response = await client.put("/api/milestones/00000000-0000-0000-0000-000000000000", json={"label": "New"})
    app.dependency_overrides.clear()

    assert response.status_code == 404

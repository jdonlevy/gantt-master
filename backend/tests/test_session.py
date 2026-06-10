import pytest

from app.dependencies import get_current_user
from app.main import app


@pytest.mark.asyncio
@pytest.mark.real_auth
async def test_session_unauthenticated(client):
    response = await client.get("/api/session")
    assert response.status_code == 200
    assert response.json() == {"authenticated": False}


@pytest.mark.asyncio
async def test_session_authenticated(client):
    """The conftest auto-overrides get_current_user with an admin User —
    /api/session should reflect that as authenticated + role=admin.
    """
    response = await client.get("/api/session")
    assert response.status_code == 200
    body = response.json()
    assert body["authenticated"] is True
    assert body["user"]["role"] == "admin"
    assert body["jiraLinked"] is False

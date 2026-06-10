import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.database import get_session
from app.dependencies import get_current_user, get_current_user_optional
from app.main import app
from app.models import Role, User
from helpers import FakeSession


async def _fake_require_auth(_request):
    """Stand-in for auth.require_auth used by tests that still need a token.

    Returns a minimal token-shaped dict so handlers that only assert on
    authentication (not specific token claims) continue to work.
    """

    return {"access_token": "test-token"}


def _fake_user(role: Role = Role.admin) -> User:
    return User(
        id=uuid.uuid4(),
        azure_oid="test-oid",
        jira_account_id="test-account",
        email="test@example.com",
        display_name="Test User",
        role=role,
        last_seen_at=datetime.now(timezone.utc),
    )


async def _override_current_user() -> User:
    return _fake_user(Role.admin)


@pytest.fixture(autouse=True)
def _stub_current_user(request):
    """Bypass auth for every test by installing an admin User as the current
    user. Tests that need to exercise the unauthenticated/forbidden path can
    opt out with `@pytest.mark.real_auth` so handlers under test see the
    actual session/role checks.
    """
    if "real_auth" in request.keywords:
        yield
        return
    previous = app.dependency_overrides.get(get_current_user)
    previous_optional = app.dependency_overrides.get(get_current_user_optional)
    app.dependency_overrides[get_current_user] = _override_current_user
    app.dependency_overrides[get_current_user_optional] = _override_current_user
    try:
        yield
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_current_user, None)
        else:
            app.dependency_overrides[get_current_user] = previous
        if previous_optional is None:
            app.dependency_overrides.pop(get_current_user_optional, None)
        else:
            app.dependency_overrides[get_current_user_optional] = previous_optional


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as session:
        yield session


@pytest.fixture
def fake_session():
    """Installs a FakeSession as the get_session dependency and yields it.

    Teardown only touches the get_session entry (restores a previous override
    if there was one, otherwise pops the key) so that overrides installed by
    other fixtures in the same test run aren't wiped.
    """
    session = FakeSession()

    async def _override_session():
        yield session

    previous = app.dependency_overrides.get(get_session)
    app.dependency_overrides[get_session] = _override_session
    try:
        yield session
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_session, None)
        else:
            app.dependency_overrides[get_session] = previous

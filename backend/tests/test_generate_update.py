"""
test_generate_update.py

Tests for _generate_summaries() and POST /api/dashboards/{slug}/generate-update.

The assertions that distinguish the Responses API implementation from the
old Chat Completions implementation are marked with "(Responses API)":
  - URL:       https://api.openai.com/v1/responses  (not /v1/chat/completions)
  - Fields:    instructions + input                  (not messages[])
  - JSON mode: text.format.type                      (not response_format.type)
  - Model:     gpt-5.4                               (not gpt-4o)
  - Output:    data["output_text"]                   (not choices[0].message.content)
"""
import importlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from unittest.mock import MagicMock

from app.database import get_session
from app.main import app
from app.models import Dashboard
from helpers import FakeSession


# ── Shared fixtures ───────────────────────────────────────────────────────────

# A well-formed Responses API payload (output_text at top level).
RESPONSES_API_PAYLOAD = {
    "output_text": '{"v1": "Work progressed on the authentication flow."}',
    "output": [
        {
            "type": "message",
            "content": [{"type": "output_text", "text": '{"v1": "Work progressed."}'}],
        }
    ],
}


class FakeHttpxClient:
    """Drop-in async context manager that captures outgoing requests."""

    def __init__(self, captured: dict, *, status_code: int = 200, payload: dict | None = None):
        self._captured = captured
        self._status_code = status_code
        self._payload = payload if payload is not None else RESPONSES_API_PAYLOAD

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def post(self, url, *, headers, json, **_kwargs):
        self._captured["url"] = url
        self._captured["headers"] = headers
        self._captured["json"] = json

        resp = MagicMock()
        resp.is_success = self._status_code < 400
        resp.status_code = self._status_code
        resp.text = ""
        resp.json.return_value = self._payload
        return resp


def patch_httpx(monkeypatch, captured: dict, *, status_code: int = 200, payload: dict | None = None):
    monkeypatch.setattr(
        "httpx.AsyncClient",
        lambda *args, **kwargs: FakeHttpxClient(captured, status_code=status_code, payload=payload),
    )


# Minimal in-progress section fed to _generate_summaries.
IN_PROGRESS_SECTION = {
    "id": "v1",
    "name": "IP11 • Feature A",
    "_is_released": False,
    "ticketTodo": 2,
    "ticketTotal": 5,
    "_by_status": {"In Progress": [{"summary": "Add login page"}]},
}

RELEASED_SECTION = {
    "id": "v1",
    "name": "IP10 • Feature A",
    "_is_released": True,
    "releasedDate": "8 Apr 2026",
    "_done_summaries": ["Implement OAuth flow", "Add logout endpoint"],
}


async def fake_get_jira_token(_db, _user):
    return {"access_token": "tok", "userAccountId": "u1"}


async def fake_fetch_versions(_token, _project):
    # Released 3 days ago — passes the "within last 2 weeks" filter.
    recent = (datetime.now(timezone.utc) - timedelta(days=3)).date().isoformat()
    return [
        {
            "id": "v1",
            "name": "IP11 • Feature A",
            "released": True,
            "releaseDate": recent,
            "startDate": None,
        }
    ]


async def fake_search_issues(_token, _jql, fields=None):
    return []


def make_dashboard(slug="test-dash", projects=None):
    return Dashboard(
        id=uuid.uuid4(),
        slug=slug,
        title="Test Dashboard",
        filters_json={"projects": projects if projects is not None else ["GPO"]},
        description=None,
        folder=None,
    )


# ── Unit: _generate_summaries ─────────────────────────────────────────────────

async def test_no_api_key_returns_empty_dict(monkeypatch):
    """With no API key the function short-circuits and makes no HTTP call."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "")

    captured = {}
    patch_httpx(monkeypatch, captured)

    result = await mod._generate_summaries([IN_PROGRESS_SECTION])

    assert result == {}
    assert captured == {}, "No HTTP request should have been made"


async def test_uses_responses_api_endpoint(monkeypatch):
    """(Responses API) Request must target /v1/responses, not /v1/chat/completions."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured)

    await mod._generate_summaries([IN_PROGRESS_SECTION])

    assert captured["url"] == "https://api.openai.com/v1/responses"


async def test_uses_correct_model(monkeypatch):
    """(Responses API) Model must be gpt-5.4."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured)

    await mod._generate_summaries([IN_PROGRESS_SECTION])

    assert captured["json"]["model"] == "gpt-5.4"


async def test_request_body_uses_responses_api_fields(monkeypatch):
    """(Responses API) Body must have instructions + input + text.format.
    Must NOT contain messages[] or response_format."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured)

    await mod._generate_summaries([IN_PROGRESS_SECTION])

    body = captured["json"]
    assert "instructions" in body, "Responses API uses 'instructions', not a system message"
    assert "input" in body, "Responses API uses 'input', not 'messages'"
    assert body.get("text") == {"format": {"type": "json_object"}}, (
        "Responses API uses text.format for JSON mode"
    )
    assert "messages" not in body, "Chat Completions 'messages' must not be present"
    assert "response_format" not in body, "Chat Completions 'response_format' must not be present"


async def test_instructions_contain_version_ids_for_in_progress(monkeypatch):
    """The version ID and name appear in the prompt input so the model knows what to summarise."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured)

    await mod._generate_summaries([IN_PROGRESS_SECTION])

    user_input = captured["json"]["input"]
    assert "v1" in user_input
    assert "IP11" in user_input
    assert "IN PROGRESS" in user_input


async def test_instructions_contain_version_ids_for_released(monkeypatch):
    """Released section prompt includes the RELEASED label and delivered tickets."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured)

    await mod._generate_summaries([RELEASED_SECTION])

    user_input = captured["json"]["input"]
    assert "RELEASED" in user_input
    assert "Implement OAuth flow" in user_input


async def test_output_parsed_from_output_text(monkeypatch):
    """(Responses API) Result must come from data['output_text'], not choices[0].message.content."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured)

    result = await mod._generate_summaries([IN_PROGRESS_SECTION])

    assert result == {"v1": "Work progressed on the authentication flow."}


async def test_output_parsed_from_raw_output_array(monkeypatch):
    """Falls back to output[].content[].text when output_text is absent (raw HTTP shape)."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    raw_payload = {
        # No top-level output_text — raw REST response shape
        "output": [
            {
                "type": "message",
                "content": [
                    {"type": "output_text", "text": '{"v1": "Delivered via raw output array."}'},
                ],
            }
        ],
    }
    captured = {}
    patch_httpx(monkeypatch, captured, payload=raw_payload)

    result = await mod._generate_summaries([IN_PROGRESS_SECTION])

    assert result == {"v1": "Delivered via raw output array."}


async def test_http_error_raises(monkeypatch):
    """Non-2xx from OpenAI must raise an exception (not silently return {})."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured, status_code=404, payload={"error": "not found"})

    with pytest.raises(Exception, match="OpenAI 404"):
        await mod._generate_summaries([IN_PROGRESS_SECTION])


# ── Integration: endpoint ─────────────────────────────────────────────────────

async def test_endpoint_404_when_dashboard_missing(client, monkeypatch):
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "get_jira_token", fake_get_jira_token)

    session = FakeSession()

    async def override():
        yield session

    app.dependency_overrides[get_session] = override
    resp = await client.post("/api/dashboards/does-not-exist/generate-update")
    app.dependency_overrides.clear()

    assert resp.status_code == 404


async def test_endpoint_400_when_no_projects_configured(client, monkeypatch):
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "get_jira_token", fake_get_jira_token)

    session = FakeSession(dashboards=[make_dashboard(slug="empty", projects=[])])

    async def override():
        yield session

    app.dependency_overrides[get_session] = override
    resp = await client.post("/api/dashboards/empty/generate-update")
    app.dependency_overrides.clear()

    assert resp.status_code == 400
    assert "no projects" in resp.json()["detail"].lower()


async def test_endpoint_happy_path_returns_sections(client, monkeypatch):
    """Full happy path: Jira mocked, OpenAI mocked → structured response returned."""
    mod = importlib.import_module("app.routers.generate_update")
    monkeypatch.setattr(mod, "get_jira_token", fake_get_jira_token)
    monkeypatch.setattr(mod, "fetch_versions", fake_fetch_versions)
    monkeypatch.setattr(mod, "search_issues", fake_search_issues)
    monkeypatch.setattr(mod, "OPENAI_API_KEY", "sk-test")

    captured = {}
    patch_httpx(monkeypatch, captured)

    session = FakeSession(dashboards=[make_dashboard(slug="gpo-dash", projects=["GPO"])])

    async def override():
        yield session

    app.dependency_overrides[get_session] = override
    resp = await client.post("/api/dashboards/gpo-dash/generate-update")
    app.dependency_overrides.clear()

    assert resp.status_code == 200
    data = resp.json()
    # Top-level shape
    assert "generatedAt" in data
    assert "project" in data
    assert "active" in data
    assert "released" in data
    # OpenAI was called (API key was set and Jira returned versions)
    assert captured.get("url") == "https://api.openai.com/v1/responses"

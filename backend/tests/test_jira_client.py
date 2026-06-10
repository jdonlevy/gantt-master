import httpx
import pytest

from app.jira_client import search_issues, search_issues_total


@pytest.mark.asyncio
async def test_search_issues_total_payload(monkeypatch):
    captured = {}

    class FakeResponse:
        def __init__(self):
            self.status_code = 200
            self._json = {"total": 7}
            self.text = "ok"
            self.request = httpx.Request("POST", "https://example.com")

        def json(self):
            return self._json

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    token = {"access_token": "token", "cloud_id": "cloud"}
    total = await search_issues_total(token, 'project = "GPO"')

    assert total == 7
    assert captured["url"].endswith("/rest/api/3/search/jql")
    assert captured["json"]["jql"] == 'project = "GPO"'
    assert captured["json"]["maxResults"] == 100
    assert captured["json"]["fields"] == ["id"]


@pytest.mark.asyncio
async def test_search_issues_uses_jql_endpoint(monkeypatch):
    captured = {"payloads": []}

    class FakeResponse:
        def __init__(self, payload_index: int):
            self.status_code = 200
            self.text = "ok"
            self._payload_index = payload_index
            self.request = httpx.Request("POST", "https://example.com")

        def json(self):
            if self._payload_index == 0:
                return {"issues": [{"id": "1"}], "nextPageToken": "next"}
            return {"issues": [], "nextPageToken": None}

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["payloads"].append(json)
            return FakeResponse(len(captured["payloads"]) - 1)

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    token = {"access_token": "token", "cloud_id": "cloud"}
    results = await search_issues(token, 'project = "GPO"', ["summary"])

    assert captured["url"].endswith("/rest/api/3/search/jql")
    assert results == [{"id": "1"}]
    assert "nextPageToken" not in captured["payloads"][0]
    assert captured["payloads"][1]["nextPageToken"] == "next"

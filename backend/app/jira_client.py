import logging
from typing import Dict, List, Optional
import httpx
from .settings import settings

logger = logging.getLogger("uvicorn.error")


async def fetch_projects(token: str) -> List[Dict[str, str]]:
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/project/search"
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    projects: List[Dict[str, str]] = []
    start_at = 0
    max_results = 100

    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            response = await client.get(
                url,
                headers=headers,
                params={"startAt": start_at, "maxResults": max_results},
            )
            response.raise_for_status()
            data = response.json()
            values = data.get("values", [])
            projects.extend({"key": item["key"], "name": item["name"]} for item in values)

            if data.get("isLast") or start_at + max_results >= data.get("total", 0):
                break
            start_at += max_results

    return projects


async def fetch_versions(token: str, project_key: str) -> List[Dict[str, Optional[str]]]:
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/project/{project_key}/versions"
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        return response.json()


async def search_issues(token: str, jql: str, fields: List[str]) -> List[Dict]:
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/search/jql"
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    issues: List[Dict] = []
    next_page_token: Optional[str] = None
    max_results = 100
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            payload = {
                "jql": jql,
                "fields": fields,
                "maxResults": max_results,
            }
            if next_page_token:
                payload["nextPageToken"] = next_page_token
            response = await client.post(url, headers=headers, json=payload)
            if response.status_code >= 400:
                print(
                    f"Jira search failed url={url} payload={payload} response={response.text}"
                )
                logger.error(
                    "Jira search failed (status=%s). jql=%s payload=%s response=%s",
                    response.status_code,
                    jql,
                    payload,
                    response.text,
                )
            response.raise_for_status()
            data = response.json()
            batch = data.get("issues") or data.get("values") or []
            issues.extend(batch)
            next_page_token = data.get("nextPageToken")
            if not next_page_token or not batch:
                break
    return issues


async def search_issues_total(token: str, jql: str) -> int:
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/search/jql"
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    next_page_token: Optional[str] = None
    max_results = 100
    total = 0
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            payload = {"jql": jql, "maxResults": max_results, "fields": ["id"]}
            if next_page_token:
                payload["nextPageToken"] = next_page_token
            response = await client.post(url, headers=headers, json=payload)
            if response.status_code >= 400:
                print(
                    f"Jira search total failed url={url} payload={payload} response={response.text}"
                )
                logger.error(
                    "Jira search total failed (status=%s). jql=%s payload=%s response=%s",
                    response.status_code,
                    jql,
                    payload,
                    response.text,
                )
            response.raise_for_status()
            data = response.json()
            if data.get("total") is not None:
                return int(data.get("total", 0))
            batch = data.get("issues") or data.get("values") or []
            total += len(batch)
            next_page_token = data.get("nextPageToken")
            if not next_page_token or not batch:
                break
    return total


async def fetch_issue_changelog(
    token: str,
    issue_key: str,
    *,
    client: Optional[httpx.AsyncClient] = None,
) -> List[Dict]:
    """Return the full status/field change history for a single Jira issue.

    The Jira Cloud `/search/jql` endpoint (which we use for bulk issue search)
    no longer supports `expand=changelog`, so for use cases like "when did this
    story first move into In Progress?" we have to hit the per-issue endpoint.
    Call sparingly — every call is one HTTP round-trip.

    Pass `client` when calling this in a tight loop (e.g. the roadmap
    per-story fan-out). Re-using a single AsyncClient avoids constructing a
    fresh SSL context + connection pool for every issue, which materially
    cuts allocation churn under load. When `client` is omitted, a
    request-scoped client is constructed as before.
    """
    url = (
        f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}"
        f"/rest/api/3/issue/{issue_key}/changelog"
    )
    headers = {"Authorization": f"Bearer {token['access_token']}"}

    async def _run(http_client: httpx.AsyncClient) -> List[Dict]:
        histories: List[Dict] = []
        start_at = 0
        max_results = 100
        while True:
            response = await http_client.get(
                url,
                headers=headers,
                params={"startAt": start_at, "maxResults": max_results},
            )
            response.raise_for_status()
            data = response.json()
            values = data.get("values") or []
            histories.extend(values)
            if data.get("isLast", True) or not values:
                break
            start_at += len(values)
        return histories

    if client is not None:
        return await _run(client)
    async with httpx.AsyncClient(timeout=30) as owned_client:
        return await _run(owned_client)


async def fetch_statuses(token: str) -> List[Dict[str, str]]:
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/status"
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        return [
            {
                "name": item["name"],
                "category": (item.get("statusCategory") or {}).get("key"),
            }
            for item in data
        ]


async def fetch_issue_types(token: str) -> List[Dict[str, str]]:
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/issuetype"
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        return [{"id": item["id"], "name": item["name"]} for item in data if not item.get("subtask")]


async def fetch_components(token: str, project_key: str) -> List[Dict[str, str]]:
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/project/{project_key}/components"
    headers = {"Authorization": f"Bearer {token['access_token']}"}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        return [{"id": item["id"], "name": item["name"]} for item in data]

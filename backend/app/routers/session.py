"""``GET /api/session`` — surfaces the current Azure AD user and Jira linkage.

Unauthenticated callers get ``{"authenticated": false}``. Authenticated
callers get their User row (id, email, displayName, role) and a
``jiraLinked`` boolean so the SPA can prompt for a Jira link before
trying to load Jira data.
"""

from fastapi import APIRouter, Depends

from ..dependencies import get_current_user_optional
from ..models import User

router = APIRouter()


@router.get("/session")
async def get_session_status(user: User | None = Depends(get_current_user_optional)):
    if user is None:
        return {"authenticated": False}
    return {
        "authenticated": True,
        "user": {
            "id": str(user.id),
            "email": user.email,
            "displayName": user.display_name,
            "role": user.role.value,
        },
        "jiraLinked": bool(user.jira_token_json),
    }

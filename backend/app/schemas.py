from datetime import date
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, field_validator, model_validator

ALLOWED_FOLDERS = {
    "AI",
    "gPlan Outdoor",
    "International",
    "Outdoor Fulfilment",
    "Programme",
    "Radio",
    "Sales Ops",
    "Self Service",
    "Shared Services",
}


class ProjectOut(BaseModel):
    key: str
    name: str


class StatusOut(BaseModel):
    name: str


class IssueTypeOut(BaseModel):
    id: str
    name: str


class FixVersionFilterOut(BaseModel):
    id: str
    name: str
    projectKey: Optional[str] = None
    release: Optional[str] = None
    released: Optional[bool] = None
    archived: Optional[bool] = None


class ComponentOut(BaseModel):
    id: str
    name: str


class StoryOut(BaseModel):
    id: str
    key: str
    summary: str
    start: Optional[str] = None
    end: Optional[str] = None
    url: Optional[str] = None
    # Jira statusCategory key ("new" | "indeterminate" | "done") — used by the
    # Gantt to colour story bars grey/green/blue respectively.
    status: Optional[str] = None
    # Raw Jira status name (e.g. "In Progress", "Done - Released",
    # "Ready for Development") — displayed in the bar hover tooltip so users
    # can see the specific workflow state, not just the rolled-up category.
    statusName: Optional[str] = None


class EpicOut(BaseModel):
    id: str
    key: str
    summary: str
    start: Optional[str] = None
    end: Optional[str] = None
    url: Optional[str] = None
    # Jira statusCategory key ("new" | "indeterminate" | "done") — used by the
    # Gantt to colour a finished epic blue regardless of dates/progress.
    status: Optional[str] = None
    # Per-epic completion, counted from the epic's own stories (excluding Closed).
    # Frontend mirrors fix-version shading against these.
    progressDone: int = 0
    progressTotal: int = 0
    stories: List[StoryOut] = []


class FixVersionOut(BaseModel):
    id: str
    projectKey: Optional[str] = None
    name: str
    start: Optional[str] = None
    release: Optional[str] = None
    released: Optional[bool] = None
    archived: Optional[bool] = None
    url: Optional[str] = None
    progressDone: int = 0
    progressInProgress: int = 0
    progressTotal: int = 0
    uatStart: Optional[str] = None
    uatEnd: Optional[str] = None
    liveStart: Optional[str] = None
    liveEnd: Optional[str] = None
    notes: Optional[str] = None
    epics: List[EpicOut] = []
    # Keys of tickets in OTHER projects that any epic or story in this fix
    # version is linked to. Drives the exclamation-circle indicator on the
    # Gantt bar so PMs can spot external dependencies at a glance.
    externalLinks: List[str] = []


class MilestoneOut(BaseModel):
    id: str
    label: str
    date: str
    color: str
    projectScope: Optional[str] = None
    showLabel: bool = True
    dashboardId: Optional[str] = None


class DependencyOut(BaseModel):
    fromId: str
    toId: str
    type: str
    fromKey: Optional[str] = None
    toKey: Optional[str] = None
    source: Optional[str] = None
    # Populated only for manual dependencies — the primary key of the
    # override row so the UI can target it for deletion.
    id: Optional[str] = None


class RoadmapResponse(BaseModel):
    projects: List[ProjectOut]
    fixVersions: List[FixVersionOut]
    milestones: List[MilestoneOut]
    dependencies: List[DependencyOut] = []
    updatedAt: str
    jiraBaseUrl: Optional[str] = None


class FixVersionOverrideIn(BaseModel):
    fixVersionId: str
    dashboardId: Optional[str] = None
    uatStart: Optional[str] = None
    uatEnd: Optional[str] = None
    liveStart: Optional[str] = None
    liveEnd: Optional[str] = None
    notes: Optional[str] = None

    @model_validator(mode="after")
    def _validate_ranges(self) -> "FixVersionOverrideIn":
        """Ensure start dates are on or before their corresponding end dates.

        Empty strings are treated as "no value" (same as None) so clients can
        clear a field by sending an empty string without triggering validation.
        """

        def _as_date(value: Optional[str]) -> Optional[date]:
            if not value:
                return None
            try:
                return date.fromisoformat(value)
            except ValueError as exc:
                raise ValueError(f"Invalid date format: {value!r}") from exc

        uat_start = _as_date(self.uatStart)
        uat_end = _as_date(self.uatEnd)
        live_start = _as_date(self.liveStart)
        live_end = _as_date(self.liveEnd)

        if uat_start and uat_end and uat_start > uat_end:
            raise ValueError("UAT start date must be on or before UAT end date.")
        if live_start and live_end and live_start > live_end:
            raise ValueError("Live start date must be on or before Live end date.")
        return self


ALLOWED_DEPENDENCY_NODE_TYPES = {"epic", "fix"}


class DependencyOverrideIn(BaseModel):
    """Payload for creating a manual dependency override.

    `fromType` / `toType` are the Gantt RowItem discriminator values. We only
    allow dependencies between epics and fix versions — stories are excluded
    per the agreed scope.
    """

    fromId: str
    toId: str
    fromType: str
    toType: str
    dashboardId: Optional[str] = None

    @model_validator(mode="after")
    def _validate(self) -> "DependencyOverrideIn":
        if not self.fromId or not self.toId:
            raise ValueError("fromId and toId are required.")
        if self.fromId == self.toId:
            raise ValueError("A dependency cannot point to itself.")
        for field, value in (("fromType", self.fromType), ("toType", self.toType)):
            if value not in ALLOWED_DEPENDENCY_NODE_TYPES:
                raise ValueError(
                    f"{field} must be one of {sorted(ALLOWED_DEPENDENCY_NODE_TYPES)}"
                )
        return self


class DependencyOverrideOut(BaseModel):
    id: str
    fromId: str
    toId: str
    fromType: str
    toType: str
    dashboardId: Optional[str] = None


class MilestoneIn(BaseModel):
    label: str
    date: str
    color: str
    projectScope: Optional[str] = None
    showLabel: bool = True
    dashboardId: Optional[str] = None


class MilestoneUpdate(BaseModel):
    label: Optional[str] = None
    date: Optional[str] = None
    color: Optional[str] = None
    projectScope: Optional[str] = None
    showLabel: Optional[bool] = None
    dashboardId: Optional[str] = None


class Swimlane(BaseModel):
    id: str
    name: str
    fixVersionIds: List[str] = []


class Initiative(BaseModel):
    id: str
    name: str
    colour: Optional[str] = None
    swimlaneIds: List[str] = []
    fixVersionIds: List[str] = []


class BarColourCategory(BaseModel):
    id: str
    name: str
    colour: str


class CustomBarOut(BaseModel):
    id: str
    name: str
    swimlaneId: Optional[str] = None
    start: str
    end: str
    color: str = '#a78bfa'
    showName: bool = True
    dashboardId: str


class CustomBarIn(BaseModel):
    name: str
    swimlaneId: Optional[str] = None
    start: str
    end: str
    color: str = '#a78bfa'
    showName: bool = True
    dashboardId: str


class CustomBarUpdate(BaseModel):
    name: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    color: Optional[str] = None
    showName: Optional[bool] = None


class DashboardFilters(BaseModel):
    projects: List[str] = []
    fixVersions: List[str] = []
    components: List[str] = []
    incrementStart: Optional[str] = None
    incrementEnd: Optional[str] = None
    ganttMode: Optional[str] = None
    timeScale: Optional[str] = None
    showDependencies: Optional[bool] = None
    swimlanes: List[Swimlane] = []
    initiatives: List[Initiative] = []
    showInitiatives: Optional[bool] = None
    collapsedInitiatives: List[str] = []
    barColourCategories: List[BarColourCategory] = []
    fixVersionColours: Dict[str, str] = {}
    colourByCategory: Optional[bool] = None
    barColourMode: Optional[str] = None
    autoBarColours: Dict[str, str] = {}
    filtersCollapsed: Optional[bool] = None
    milestonesCollapsed: Optional[bool] = None
    customBarsCollapsed: Optional[bool] = None
    updateFixVersions: List[str] = []
    updateStart: Optional[str] = None
    updateEnd: Optional[str] = None


class DashboardSummaryOut(BaseModel):
    id: str
    slug: str
    title: str
    folder: Optional[str] = None
    description: Optional[str] = None
    updatedAt: Optional[str] = None


class DashboardPanelOut(BaseModel):
    id: str
    type: str
    title: Optional[str] = None
    row: int
    column: int
    width: int
    height: int
    collapsed: bool = False
    contentJson: Optional[Dict[str, Any]] = None
    contentHtml: Optional[str] = None
    updatedAt: Optional[str] = None


class DashboardDetailOut(BaseModel):
    id: str
    slug: str
    title: str
    folder: Optional[str] = None
    description: Optional[str] = None
    filters: Optional[DashboardFilters] = None
    panels: List[DashboardPanelOut] = []
    customBars: List[CustomBarOut] = []
    updatedAt: Optional[str] = None


class DashboardCreateIn(BaseModel):
    title: str
    slug: Optional[str] = None
    folder: Optional[str] = None
    description: Optional[str] = None
    filters: Optional[DashboardFilters] = None

    @field_validator("folder", mode="before")
    @classmethod
    def normalise_folder(cls, v: object) -> Optional[str]:
        if v is None:
            return None
        stripped = str(v).strip()
        if not stripped:
            return None
        if stripped not in ALLOWED_FOLDERS:
            raise ValueError(f"folder must be one of {sorted(ALLOWED_FOLDERS)}")
        return stripped


class DashboardUpdateIn(BaseModel):
    title: Optional[str] = None
    folder: Optional[str] = None
    description: Optional[str] = None
    filters: Optional[DashboardFilters] = None

    @field_validator("folder", mode="before")
    @classmethod
    def normalise_folder(cls, v: object) -> Optional[str]:
        if v is None:
            return None
        stripped = str(v).strip()
        if not stripped:
            return None
        if stripped not in ALLOWED_FOLDERS:
            raise ValueError(f"folder must be one of {sorted(ALLOWED_FOLDERS)}")
        return stripped


class DashboardPanelCreateIn(BaseModel):
    type: str
    title: Optional[str] = None
    row: int
    column: int
    width: int
    height: int


class DashboardPanelUpdateIn(BaseModel):
    title: Optional[str] = None
    row: Optional[int] = None
    column: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    collapsed: Optional[bool] = None


class DashboardPanelContentIn(BaseModel):
    contentJson: Optional[Dict[str, Any]] = None
    contentHtml: Optional[str] = None


class MetricsIssueOut(BaseModel):
    key: str
    summary: str
    status: str
    project: str
    url: Optional[str] = None


class MetricsResponse(BaseModel):
    count: int
    issues: List[MetricsIssueOut]

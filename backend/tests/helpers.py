import uuid
from datetime import datetime

from app.models import (
    Dashboard,
    DashboardPanel,
    DependencyOverride,
    FixVersionOverride,
    Milestone,
)


class FakeScalars:
    def __init__(self, items):
        self._items = list(items)

    def all(self):
        return list(self._items)

    def first(self):
        return self._items[0] if self._items else None

    def __iter__(self):
        return iter(self._items)


class FakeResult:
    def __init__(self, items):
        self._items = list(items)

    def scalars(self):
        return FakeScalars(self._items)

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None


class FakeSession:
    def __init__(
        self,
        dashboards=None,
        panels=None,
        milestones=None,
        overrides=None,
        dependency_overrides=None,
    ):
        self.dashboards = list(dashboards or [])
        self.panels = list(panels or [])
        self.milestones = list(milestones or [])
        self.overrides = list(overrides or [])
        self.dependency_overrides = list(dependency_overrides or [])
        self._integrity_error_cls = None

    async def execute(self, stmt):
        entity = stmt.column_descriptions[0].get("entity")
        params = stmt.compile().params

        if entity is Dashboard:
            items = self._filter_dashboards(params)
            if "updated_at" in str(stmt).lower():
                items = sorted(items, key=lambda item: item.updated_at or datetime.min, reverse=True)
            return FakeResult(items)

        if entity is DashboardPanel:
            items = self._filter_panels(params)
            if "dashboard_panels.row" in str(stmt).lower():
                items = sorted(items, key=lambda item: (item.row, item.column))
            return FakeResult(items)

        if entity is Milestone:
            items = self._filter_milestones(params)
            return FakeResult(items)

        if entity is FixVersionOverride:
            items = self._filter_overrides(params)
            return FakeResult(items)

        if entity is DependencyOverride:
            items = self._filter_dependency_overrides(params)
            return FakeResult(items)

        return FakeResult([])

    async def get(self, _entity, _pk):
        # FakeSession doesn't track sessions/users; routers that use
        # AsyncSession.get for those tables get None and fall through to
        # their "no row" branch (or to whatever override the test set up).
        return None

    async def flush(self):
        for item in self.dashboards:
            if item.id is None:
                item.id = uuid.uuid4()
        for item in self.panels:
            if item.id is None:
                item.id = uuid.uuid4()
        for item in self.milestones:
            if item.id is None:
                item.id = uuid.uuid4()

    async def commit(self):
        # Emulate the uniqueness constraint so route-level IntegrityError
        # handling actually gets exercised by the tests.
        from sqlalchemy.exc import IntegrityError

        seen = set()
        for item in self.dependency_overrides:
            key = (
                str(item.dashboard_id) if item.dashboard_id else None,
                item.from_id,
                item.to_id,
            )
            if key in seen:
                raise IntegrityError("duplicate", None, None)
            seen.add(key)
        return None

    async def rollback(self):
        # Last-added dependency override is the one that tripped the check.
        if self.dependency_overrides:
            self.dependency_overrides.pop()
        return None

    async def refresh(self, _item):
        return None

    def add(self, item):
        if isinstance(item, Dashboard):
            if item.id is None:
                item.id = uuid.uuid4()
            self.dashboards.append(item)
        elif isinstance(item, DashboardPanel):
            if item.id is None:
                item.id = uuid.uuid4()
            self.panels.append(item)
        elif isinstance(item, Milestone):
            if item.id is None:
                item.id = uuid.uuid4()
            self.milestones.append(item)
        elif isinstance(item, FixVersionOverride):
            self.overrides.append(item)
        elif isinstance(item, DependencyOverride):
            if item.id is None:
                item.id = uuid.uuid4()
            self.dependency_overrides.append(item)

    async def delete(self, item):
        if isinstance(item, DashboardPanel):
            self.panels = [panel for panel in self.panels if panel.id != item.id]
        elif isinstance(item, Dashboard):
            self.dashboards = [dashboard for dashboard in self.dashboards if dashboard.id != item.id]
            self.panels = [panel for panel in self.panels if panel.dashboard_id != item.id]
            self.milestones = [milestone for milestone in self.milestones if milestone.dashboard_id != item.id]
            self.overrides = [override for override in self.overrides if override.dashboard_id != item.id]
            self.dependency_overrides = [
                item_ for item_ in self.dependency_overrides if item_.dashboard_id != item.id
            ]
        elif isinstance(item, Milestone):
            self.milestones = [milestone for milestone in self.milestones if milestone.id != item.id]
        elif isinstance(item, DependencyOverride):
            self.dependency_overrides = [
                existing for existing in self.dependency_overrides if existing.id != item.id
            ]

    def _filter_dashboards(self, params):
        items = list(self.dashboards)
        slug = params.get("slug_1")
        if slug:
            items = [item for item in items if item.slug == slug]
        return items

    def _filter_panels(self, params):
        items = list(self.panels)
        dashboard_id = params.get("dashboard_id_1")
        panel_id = params.get("id_1")
        if dashboard_id:
            items = [item for item in items if str(item.dashboard_id) == str(dashboard_id)]
        if panel_id:
            items = [item for item in items if str(item.id) == str(panel_id)]
        return items

    def _filter_milestones(self, params):
        items = list(self.milestones)
        milestone_id = params.get("id_1")
        dashboard_id = params.get("dashboard_id_1")
        if milestone_id:
            items = [item for item in items if str(item.id) == str(milestone_id)]
        if dashboard_id:
            items = [item for item in items if str(item.dashboard_id) == str(dashboard_id)]
        return items

    def _filter_overrides(self, params):
        items = list(self.overrides)
        fix_version_id = params.get("fix_version_id_1")
        dashboard_id = params.get("dashboard_id_1")
        if fix_version_id:
            items = [item for item in items if item.fix_version_id == fix_version_id]
        if dashboard_id:
            items = [item for item in items if str(item.dashboard_id) == str(dashboard_id)]
        return items

    def _filter_dependency_overrides(self, params):
        items = list(self.dependency_overrides)
        from_id = params.get("from_id_1")
        to_id = params.get("to_id_1")
        id_ = params.get("id_1")
        dashboard_id = params.get("dashboard_id_1")
        if from_id:
            items = [item for item in items if item.from_id == from_id]
        if to_id:
            items = [item for item in items if item.to_id == to_id]
        if id_:
            items = [item for item in items if str(item.id) == str(id_)]
        if dashboard_id:
            items = [item for item in items if str(item.dashboard_id) == str(dashboard_id)]
        return items

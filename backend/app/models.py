import enum
from sqlalchemy import Boolean, Column, Date, DateTime, Enum, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import expression
import uuid
from .database import Base


class Role(str, enum.Enum):
    viewer = "viewer"
    editor = "editor"
    admin = "admin"


ROLE_RANK = {Role.viewer: 0, Role.editor: 1, Role.admin: 2}


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Azure AD object id — primary identity key for new users post-Azure-AD
    # cutover. Nullable so existing rows (created via the old Jira OAuth
    # login) survive the migration; populated on first Azure AD login.
    azure_oid = Column(String, nullable=True, unique=True, index=True)
    # Jira accountId — populated only after a user opts to link their Jira
    # account via /api/jira/link. Nullable + unique-among-non-nulls.
    jira_account_id = Column(String, nullable=True, unique=True, index=True)
    # The user's Jira OAuth token (access + refresh + cloud_id + resource_url).
    # Backend uses this for Jira API calls on the user's behalf.
    jira_token_json = Column(JSONB, nullable=True)
    email = Column(String, nullable=True, index=True)
    display_name = Column(String, nullable=True)
    role = Column(Enum(Role, name="user_role"), nullable=False, default=Role.viewer)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)


class FixVersionOverride(Base):
    __tablename__ = "fix_version_overrides"
    __table_args__ = (
        UniqueConstraint("dashboard_id", "fix_version_id", name="uq_fix_version_overrides_dashboard_fix"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dashboard_id = Column(UUID(as_uuid=True), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=True)
    fix_version_id = Column(String, nullable=False)
    uat_start = Column(Date, nullable=True)
    uat_end = Column(Date, nullable=True)
    live_start = Column(Date, nullable=True)
    live_end = Column(Date, nullable=True)
    notes = Column(Text, nullable=True)


class DependencyOverride(Base):
    """Manual "A blocks B" dependency scoped to a dashboard.

    Mirrors FixVersionOverride: the dashboard picks how to present Jira data,
    and manual overrides are layered on top without touching Jira itself.
    `from_type` / `to_type` are stored so we can filter to epic/fix-version
    dependencies without resolving the id against the live roadmap.
    """

    __tablename__ = "dependency_overrides"
    __table_args__ = (
        UniqueConstraint(
            "dashboard_id",
            "from_id",
            "to_id",
            name="uq_dependency_overrides_dashboard_from_to",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dashboard_id = Column(
        UUID(as_uuid=True),
        ForeignKey("dashboards.id", ondelete="CASCADE"),
        nullable=True,
    )
    from_id = Column(String, nullable=False)
    to_id = Column(String, nullable=False)
    # "epic" or "fix" — matches the `type` discriminator on Gantt RowItem.
    from_type = Column(String, nullable=False)
    to_type = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Milestone(Base):
    __tablename__ = "milestones"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    label = Column(String, nullable=False)
    date = Column(Date, nullable=False)
    color = Column(String, nullable=False)
    project_scope = Column(String, nullable=True)
    show_label = Column(Boolean, nullable=False, default=True, server_default=expression.true())
    dashboard_id = Column(UUID(as_uuid=True), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=True)


class CustomBar(Base):
    __tablename__ = "custom_bars"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dashboard_id = Column(UUID(as_uuid=True), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    swimlane_id = Column(String, nullable=True)
    start = Column(String, nullable=False)
    end = Column(String, nullable=False)
    color = Column(String, nullable=False, default='#a78bfa')
    show_name = Column(Boolean, nullable=False, default=True, server_default=expression.true())


class Dashboard(Base):
    __tablename__ = "dashboards"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug = Column(String, unique=True, nullable=False)
    title = Column(String, nullable=False)
    folder = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    filters_json = Column(JSONB, nullable=True)
    roadmap_json = Column(JSONB, nullable=True)
    roadmap_updated_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class DashboardPanel(Base):
    __tablename__ = "dashboard_panels"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dashboard_id = Column(UUID(as_uuid=True), ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    type = Column(String, nullable=False)
    title = Column(String, nullable=True)
    row = Column(Integer, nullable=False)
    column = Column(Integer, nullable=False)
    width = Column(Integer, nullable=False)
    height = Column(Integer, nullable=False)
    collapsed = Column(Boolean, nullable=False, default=False, server_default="false")
    content_json = Column(JSONB, nullable=True)
    content_html = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class AuthSession(Base):
    __tablename__ = "sessions"

    id = Column(String, primary_key=True)
    token_json = Column(JSONB, nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

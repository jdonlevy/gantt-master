"""dashboard scoped milestones and overrides

Revision ID: 0006
Revises: 0005
Create Date: 2026-02-22
"""

from alembic import op
import sqlalchemy as sa
import sqlalchemy.dialects.postgresql as pg


revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("fix_version_overrides", sa.Column("dashboard_id", pg.UUID(as_uuid=True), nullable=True))
    op.add_column("milestones", sa.Column("dashboard_id", pg.UUID(as_uuid=True), nullable=True))

    op.create_foreign_key(
        "fk_fix_version_overrides_dashboard",
        "fix_version_overrides",
        "dashboards",
        ["dashboard_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_milestones_dashboard",
        "milestones",
        "dashboards",
        ["dashboard_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_constraint("fix_version_overrides_fix_version_id_key", "fix_version_overrides", type_="unique")
    op.create_unique_constraint(
        "uq_fix_version_overrides_dashboard_fix",
        "fix_version_overrides",
        ["dashboard_id", "fix_version_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_fix_version_overrides_dashboard_fix", "fix_version_overrides", type_="unique")
    op.create_unique_constraint(
        "fix_version_overrides_fix_version_id_key",
        "fix_version_overrides",
        ["fix_version_id"],
    )

    op.drop_constraint("fk_fix_version_overrides_dashboard", "fix_version_overrides", type_="foreignkey")
    op.drop_constraint("fk_milestones_dashboard", "milestones", type_="foreignkey")

    op.drop_column("milestones", "dashboard_id")
    op.drop_column("fix_version_overrides", "dashboard_id")

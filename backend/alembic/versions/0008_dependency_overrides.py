"""dependency overrides (manual blocks links)

Revision ID: 0008
Revises: 0007
Create Date: 2026-04-18
"""

from alembic import op
import sqlalchemy as sa
import sqlalchemy.dialects.postgresql as pg


revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dependency_overrides",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("dashboard_id", pg.UUID(as_uuid=True), nullable=True),
        sa.Column("from_id", sa.String(), nullable=False),
        sa.Column("to_id", sa.String(), nullable=False),
        sa.Column("from_type", sa.String(), nullable=False),
        sa.Column("to_type", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["dashboard_id"],
            ["dashboards.id"],
            name="fk_dependency_overrides_dashboard",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "dashboard_id",
            "from_id",
            "to_id",
            name="uq_dependency_overrides_dashboard_from_to",
        ),
    )
    # Roadmap loads filter by dashboard_id (and tolerate NULL for the
    # shared/default scope), so an index here keeps those queries cheap as the
    # override table grows.
    op.create_index(
        "ix_dependency_overrides_dashboard_id",
        "dependency_overrides",
        ["dashboard_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_dependency_overrides_dashboard_id",
        table_name="dependency_overrides",
    )
    op.drop_table("dependency_overrides")

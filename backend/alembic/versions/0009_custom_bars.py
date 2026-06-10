"""custom bars table

Revision ID: 0009
Revises: 0008
Create Date: 2026-04-29
"""

from alembic import op
import sqlalchemy as sa
import sqlalchemy.dialects.postgresql as pg


revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "custom_bars",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("dashboard_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("swimlane_id", sa.String, nullable=True),
        sa.Column("start", sa.String, nullable=False),
        sa.Column("end", sa.String, nullable=False),
        sa.ForeignKeyConstraint(
            ["dashboard_id"],
            ["dashboards.id"],
            name="fk_custom_bars_dashboard",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_custom_bars_dashboard_id", "custom_bars", ["dashboard_id"])


def downgrade() -> None:
    op.drop_index("ix_custom_bars_dashboard_id", table_name="custom_bars")
    op.drop_table("custom_bars")

"""fix version ranges

Revision ID: 0003
Revises: 0002
Create Date: 2026-02-19
"""

from alembic import op
import sqlalchemy as sa


revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("fix_version_overrides", sa.Column("uat_start", sa.Date(), nullable=True))
    op.add_column("fix_version_overrides", sa.Column("uat_end", sa.Date(), nullable=True))
    op.add_column("fix_version_overrides", sa.Column("live_start", sa.Date(), nullable=True))
    op.add_column("fix_version_overrides", sa.Column("live_end", sa.Date(), nullable=True))

    op.execute(
        "UPDATE fix_version_overrides SET uat_start = uat_date, uat_end = uat_date WHERE uat_date IS NOT NULL"
    )
    op.execute(
        "UPDATE fix_version_overrides SET live_start = live_date, live_end = live_date WHERE live_date IS NOT NULL"
    )

    op.drop_column("fix_version_overrides", "uat_date")
    op.drop_column("fix_version_overrides", "live_date")


def downgrade() -> None:
    op.add_column("fix_version_overrides", sa.Column("uat_date", sa.Date(), nullable=True))
    op.add_column("fix_version_overrides", sa.Column("live_date", sa.Date(), nullable=True))

    op.execute(
        "UPDATE fix_version_overrides SET uat_date = uat_start WHERE uat_start IS NOT NULL"
    )
    op.execute(
        "UPDATE fix_version_overrides SET live_date = live_start WHERE live_start IS NOT NULL"
    )

    op.drop_column("fix_version_overrides", "uat_start")
    op.drop_column("fix_version_overrides", "uat_end")
    op.drop_column("fix_version_overrides", "live_start")
    op.drop_column("fix_version_overrides", "live_end")

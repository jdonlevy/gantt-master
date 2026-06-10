"""dashboard panel collapsed

Revision ID: 0016
Revises: 0015
Create Date: 2026-06-04
"""

from alembic import op
import sqlalchemy as sa


revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboard_panels",
        sa.Column("collapsed", sa.Boolean, nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("dashboard_panels", "collapsed")

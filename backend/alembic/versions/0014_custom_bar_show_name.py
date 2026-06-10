"""custom bar show_name

Revision ID: 0014
Revises: 0013
Create Date: 2026-06-02
"""

from alembic import op
import sqlalchemy as sa


revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "custom_bars",
        sa.Column("show_name", sa.Boolean, nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("custom_bars", "show_name")

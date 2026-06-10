"""custom bar colour

Revision ID: 0010
Revises: 0009
Create Date: 2026-04-29
"""

from alembic import op
import sqlalchemy as sa


revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "custom_bars",
        sa.Column("color", sa.String, nullable=False, server_default="#a78bfa"),
    )


def downgrade() -> None:
    op.drop_column("custom_bars", "color")

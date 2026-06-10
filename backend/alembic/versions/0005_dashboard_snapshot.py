"""dashboard snapshot

Revision ID: 0005
Revises: 0004
Create Date: 2026-02-20 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dashboards", sa.Column("roadmap_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("dashboards", sa.Column("roadmap_updated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("dashboards", "roadmap_updated_at")
    op.drop_column("dashboards", "roadmap_json")

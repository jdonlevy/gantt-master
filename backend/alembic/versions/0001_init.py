"""init

Revision ID: 0001
Revises: 
Create Date: 2026-02-18
"""
from alembic import op
import sqlalchemy as sa
import sqlalchemy.dialects.postgresql as pg

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'fix_version_overrides',
        sa.Column('id', pg.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('fix_version_id', sa.String(), nullable=False, unique=True),
        sa.Column('uat_date', sa.Date(), nullable=True),
        sa.Column('live_date', sa.Date(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
    )
    op.create_table(
        'milestones',
        sa.Column('id', pg.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column('label', sa.String(), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('color', sa.String(), nullable=False),
        sa.Column('project_scope', sa.String(), nullable=True),
    )


def downgrade():
    op.drop_table('milestones')
    op.drop_table('fix_version_overrides')

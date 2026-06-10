"""users.azure_oid + jira linkage columns

Revision ID: 0013
Revises: 0012
Create Date: 2026-05-11
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Azure AD object id — new primary identity key.
    op.add_column(
        "users",
        sa.Column("azure_oid", sa.String(), nullable=True),
    )
    op.create_unique_constraint("uq_users_azure_oid", "users", ["azure_oid"])
    op.create_index("ix_users_azure_oid", "users", ["azure_oid"])

    # Jira token storage (was previously in the `sessions` table — now
    # tied to the linked user).
    op.add_column(
        "users",
        sa.Column("jira_token_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    # Make jira_account_id nullable — only populated when a user links
    # their Jira account. Postgres treats NULLs as distinct under a
    # unique constraint, so the existing uniqueness still holds for
    # actual linked accounts.
    op.alter_column("users", "jira_account_id", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    op.alter_column("users", "jira_account_id", existing_type=sa.String(), nullable=False)
    op.drop_column("users", "jira_token_json")
    op.drop_index("ix_users_azure_oid", table_name="users")
    op.drop_constraint("uq_users_azure_oid", "users", type_="unique")
    op.drop_column("users", "azure_oid")

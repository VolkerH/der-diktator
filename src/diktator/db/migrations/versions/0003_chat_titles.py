"""Shared custom titles and an independent metadata revision."""

import sqlalchemy as sa
from alembic import op

revision = "0003_chat_titles"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("chats") as batch:
        batch.add_column(sa.Column("custom_title", sa.String(), nullable=True))
        batch.add_column(
            sa.Column("title_revision", sa.Integer(), nullable=False, server_default="1")
        )


def downgrade() -> None:
    with op.batch_alter_table("chats") as batch:
        batch.drop_column("title_revision")
        batch.drop_column("custom_title")

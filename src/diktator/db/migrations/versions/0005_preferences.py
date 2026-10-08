"""Add actor-scoped preamble preferences; missing rows resolve server defaults."""

import sqlalchemy as sa
from alembic import op

revision = "0005_preferences"
down_revision = "0004_chat_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "preferences",
        sa.Column(
            "user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("copy_preamble", sa.Text(), nullable=True),
        sa.Column(
            "share_include_preamble", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("preferences")

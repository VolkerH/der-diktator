"""Create the application baseline and seed its local actor."""

from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    users = op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("created", sa.DateTime(), nullable=False),
    )
    op.bulk_insert(users, [{"id": "local", "created": datetime.now(UTC).replace(tzinfo=None)}])
    op.create_table(
        "chats",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("created", sa.DateTime(), nullable=False),
        sa.Column("updated", sa.DateTime(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(), sa.ForeignKey("users.id"), nullable=False),
    )
    op.create_index("ix_chats_updated", "chats", ["updated"])
    op.create_table(
        "chat_members",
        sa.Column(
            "chat_id", sa.String(), sa.ForeignKey("chats.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("role", sa.String(), nullable=False),
    )
    op.create_table(
        "recordings",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "chat_id", sa.String(), sa.ForeignKey("chats.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("created", sa.DateTime(), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("audio_path", sa.String(), nullable=False),
    )
    op.create_index("ix_recordings_chat_id", "recordings", ["chat_id"])
    op.create_table(
        "legacy_imports",
        sa.Column("chat_id", sa.String(), primary_key=True),
        sa.Column("imported_at", sa.DateTime(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("baseline_text", sa.Text(), nullable=False),
    )


def downgrade() -> None:
    for table in ("legacy_imports", "recordings", "chat_members", "chats", "users"):
        op.drop_table(table)

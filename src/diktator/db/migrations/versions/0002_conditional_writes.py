"""Separate chat/text revisions, creation incarnations and retry payload identities."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("chats") as batch:
        batch.add_column(sa.Column("revision", sa.Integer(), nullable=False, server_default="1"))
        batch.add_column(
            sa.Column("text_revision", sa.Integer(), nullable=False, server_default="1")
        )
        batch.add_column(sa.Column("incarnation", sa.String(), nullable=False, server_default=""))
    # Every pre-existing chat gets a distinct, persisted creation identity.
    op.execute("UPDATE chats SET incarnation = lower(hex(randomblob(16)))")
    with op.batch_alter_table("recordings") as batch:
        batch.add_column(sa.Column("audio_sha256", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("recordings") as batch:
        batch.drop_column("audio_sha256")
    with op.batch_alter_table("chats") as batch:
        for column in ("incarnation", "text_revision", "revision"):
            batch.drop_column(column)

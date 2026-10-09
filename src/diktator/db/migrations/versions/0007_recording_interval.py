"""Persist requested recording intervals; NULL follows the server default."""

import sqlalchemy as sa
from alembic import op

revision = "0007_recording_interval"
down_revision = "0006_keyboard_bindings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "preferences", sa.Column("recording_interval_seconds", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    with op.batch_alter_table("preferences") as batch:
        batch.drop_column("recording_interval_seconds")

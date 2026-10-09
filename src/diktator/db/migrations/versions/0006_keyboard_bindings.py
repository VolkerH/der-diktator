"""Persist nullable keyboard overrides; NULL follows server defaults."""

import sqlalchemy as sa
from alembic import op

revision = "0006_keyboard_bindings"
down_revision = "0005_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("preferences", sa.Column("keyboard_bindings", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("preferences") as batch:
        batch.drop_column("keyboard_bindings")

"""Actor-private groups and independent placements."""

import sqlalchemy as sa
from alembic import op

revision = "0004_chat_groups"
down_revision = "0003_chat_titles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "groups",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "owner_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("incarnation", sa.String(), nullable=False),
        sa.Column("created", sa.DateTime(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_index("ix_groups_owner_id", "groups", ["owner_id"])
    with op.batch_alter_table("chat_members") as batch:
        batch.add_column(sa.Column("group_id", sa.String(), nullable=True))
        batch.add_column(
            sa.Column("placement_revision", sa.Integer(), nullable=False, server_default="1")
        )
        batch.create_foreign_key(
            "fk_chat_member_group", "groups", ["group_id"], ["id"], ondelete="SET NULL"
        )


def downgrade() -> None:
    with op.batch_alter_table("chat_members") as batch:
        batch.drop_constraint("fk_chat_member_group", type_="foreignkey")
        batch.drop_column("placement_revision")
        batch.drop_column("group_id")
    op.drop_table("groups")

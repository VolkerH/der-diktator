"""Packaged in-process migrations with SQLite batch operations enabled."""

from alembic import context

from diktator.db.rows import Base

connection = context.config.attributes["connection"]
context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=True)
with context.begin_transaction():
    context.run_migrations()

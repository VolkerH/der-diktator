# Released SQLite schemas

`0001.sqlite3` contains the Alembic baseline, its version marker and the seeded
local user. It contains no chats or audio. The fixture is copied into a temporary
directory for tests and is never opened in place.

Add an empty fixture for each released schema when introducing a new migration.
Keep earlier fixtures so upgrades can be tested against packaged schemas.

`0002.sqlite3` adds chat/text revisions, creation incarnations and nullable
recording audio hashes. Both released fixtures are covered by startup upgrade tests.

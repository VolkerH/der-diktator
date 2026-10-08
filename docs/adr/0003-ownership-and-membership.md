# 0003. Actor context, chat membership, per-user groups

Status: Accepted (2026-10-08)

Discussion: [#15](https://github.com/VolkerH/der-diktator/issues/15) —
[collaboration follow-up](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6060764920),
[review of the reviews §2](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061024479);
[#10](https://github.com/VolkerH/der-diktator/issues/10),
[#16](https://github.com/VolkerH/der-diktator/issues/16).

## Context

Today there is one implicit local user. #10 plans accounts, and #16 plans chats shared between
users on one instance. A single owner column or ownership-based storage paths would block sharing.

## Decision

- The baseline schema contains a **seeded local user**. Application services receive an explicit
  **actor** from a server dependency, never from the request body.
- Access is decided by `chat_members(chat_id, user_id, role)`, consulted for text, audio, search,
  export, history and subscriptions. A creator/owner field may exist as metadata, not as the
  access check.
- **Audio paths** depend only on stable chat and recording IDs, not on who owns a chat. This
  replaces the `users/<user-id>/chats/<chat-id>/` layout proposed in #10.
- **Group placement is per user** (#14): two members can file the same chat in different groups.
  Private group changes are not visible to other members.
- **Chat titles are shared** by default (#2).
- **Preferences are per user**; operator configuration is instance-wide (see
  [0001](0001-sqlite-persistence.md)).

## Consequences

- #10 still needs authentication, roles, revocation and an explicit assignment of existing local
  data when accounts are enabled. The seeded user avoids a data-model migration, not that work.
- #14's `group_id` on the chat becomes a per-member placement.

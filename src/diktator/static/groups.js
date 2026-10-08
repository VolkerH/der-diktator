import { request } from "./chats.js";

/** @typedef {{id: string, name: string, created: string, revision: number, etag: string}} Group */
/** @typedef {{chat_id: string, group_id: string | null, placement_revision: number, etag: string}} Placement */

/** Private grouping has independent validators and never acknowledges shared chat state. */
export const groupApi = {
  /** @returns {Promise<Group[]>} */
  list: async () => (await request("/api/groups")).body,
  /** @param {string} id @param {string} name @returns {Promise<Group>} */
  create: async (id, name) =>
    (
      await request(`/api/groups/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    ).body,
  /** @param {Group} group @param {string} name @returns {Promise<Group>} */
  rename: async (group, name) =>
    (
      await request(`/api/groups/${group.id}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": group.etag },
        body: JSON.stringify({ name }),
      })
    ).body,
  /** @param {Group} group */
  remove: (group) =>
    request(`/api/groups/${group.id}`, { method: "DELETE", headers: { "If-Match": group.etag } }),
  /** @param {string} id @returns {Promise<Placement>} */
  placement: async (id) => {
    const { body } = await request(`/api/chats/${id}/group`);
    return body;
  },
  /** @param {string} id @param {string | null} groupId @param {string} etag @returns {Promise<Placement>} */
  move: async (id, groupId, etag) => {
    const { body } = await request(`/api/chats/${id}/group`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify({ group_id: groupId }),
    });
    return body;
  },
};

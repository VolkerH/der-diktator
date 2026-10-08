import assert from "node:assert/strict";
import test from "node:test";
import { chatApi } from "../../src/diktator/static/chats.js";
import { groupApi } from "../../src/diktator/static/groups.js";

const id = "a".repeat(32);

test("chosen chat creation sends an initial group, including explicit Unsorted", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    return Response.json({ id, revision: 1 });
  });
  await chatApi.create(id, "b".repeat(32));
  await chatApi.create(id);
  assert.equal(calls[0][0], `/api/chats/${id}`);
  assert.equal(calls[0][1].method, "PUT");
  assert.equal(calls[0][1].body, JSON.stringify({ group_id: "b".repeat(32) }));
  assert.equal(calls[1][1].body, '{"group_id":null}');
});

test("group rename/delete preserve opaque validators and chosen-ID create is retryable", async (t) => {
  const calls = [];
  const group = {
    id,
    name: "Project",
    created: "2026-10-08T10:00:00Z",
    revision: 1,
    etag: '"opaque-group"',
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    return options?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(group);
  });
  await groupApi.create(id, "Project");
  await groupApi.create(id, "Project");
  await groupApi.rename(group, "Email");
  await groupApi.remove(group);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[2][0], `/api/groups/${id}/name`);
  assert.equal(calls[2][1].headers["If-Match"], '"opaque-group"');
  assert.equal(calls[2][1].body, '{"name":"Email"}');
  assert.equal(calls[3][1].headers["If-Match"], '"opaque-group"');
});

test("private placement uses its own ETag and never exposes a shared chat validator", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    return Response.json(
      { chat_id: id, group_id: null, placement_revision: 3, etag: '"opaque-placement"' },
      { headers: { ETag: '"opaque-placement"' } },
    );
  });
  const current = await groupApi.placement(id);
  const saved = await groupApi.move(id, null, current.etag);
  assert.equal(saved.etag, '"opaque-placement"');
  assert.equal(saved.textEtag, undefined);
  assert.equal(saved.titleEtag, undefined);
  assert.equal(calls[1][1].headers["If-Match"], '"opaque-placement"');
  assert.equal(calls[1][1].body, '{"group_id":null}');
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientMessage, ServerMessage } from "../../shared/protocol.ts";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

test("accepte les messages client valides", () => {
  assert.ok(ClientMessage.safeParse({ type: "state.get" }).success);
  assert.ok(ClientMessage.safeParse({ type: "session.create", cwd: "/srv/projet", prompt: "salut" }).success);
  assert.ok(ClientMessage.safeParse({ type: "session.send", sessionId: ID, text: "suite" }).success);
  assert.ok(ClientMessage.safeParse({ type: "session.stop", sessionId: ID }).success);
});

test("rejette les messages client invalides", () => {
  const invalid: unknown[] = [
    null,
    "state.get",
    {},
    { type: "inconnu" },
    { type: "state.get", extra: 1 },
    { type: "session.create", cwd: "relatif", prompt: "x" },
    { type: "session.create", cwd: "/a\0b", prompt: "x" },
    { type: "session.create", cwd: "/srv", prompt: "" },
    { type: "session.send", sessionId: "pas-un-uuid", text: "x" },
    { type: "permission.answer", requestId: ID, allow: true },
  ];
  for (const msg of invalid) {
    assert.equal(ClientMessage.safeParse(msg).success, false, JSON.stringify(msg));
  }
});

test("valide aussi les messages sortants", () => {
  assert.ok(ServerMessage.safeParse({ type: "message.delta", sessionId: ID, text: "" }).success);
  assert.equal(ServerMessage.safeParse({ type: "error", code: "nope", message: "x" }).success, false);
});

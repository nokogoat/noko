import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionOutcome, PermissionRequest } from "../../shared/protocol.ts";
import type { SessionEvents } from "../src/claude-session.ts";
import { permissionHandler } from "../src/claude-session.ts";
import { PermissionBroker, type PermissionAsk } from "../src/permissions.ts";

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ASK: PermissionAsk = {
  toolName: "Bash",
  input: { command: "ls -la", description: "Lister" },
  title: null,
  reason: null,
  blockedPath: null,
};

function setup(timeoutMs = 60_000) {
  const requests: PermissionRequest[] = [];
  const resolved: [string, PermissionOutcome][] = [];
  const broker = new PermissionBroker(timeoutMs, {
    onRequest: (r) => requests.push(r),
    onResolved: (r, outcome) => resolved.push([r.requestId, outcome]),
  });
  return { broker, requests, resolved };
}

test("publie l'entrée exacte et applique la décision de l'utilisateur", async () => {
  const { broker, requests, resolved } = setup();
  const pending = broker.request(SESSION, ASK, new AbortController().signal);
  const [req] = requests;
  assert.ok(req);
  assert.deepEqual(req.input, ASK.input);
  assert.equal(req.toolName, "Bash");
  assert.deepEqual(broker.list(), [req]);
  assert.equal(broker.answer(req.requestId, "allow"), true);
  assert.equal(await pending, "allow");
  assert.deepEqual(resolved, [[req.requestId, "allowed"]]);
  assert.deepEqual(broker.list(), []);
});

test("usage unique : une seconde réponse est refusée", async () => {
  const { broker, requests } = setup();
  const pending = broker.request(SESSION, ASK, new AbortController().signal);
  const id = requests[0]!.requestId;
  assert.equal(broker.answer(id, "deny"), true);
  assert.equal(broker.answer(id, "allow"), false);
  assert.equal(await pending, "deny");
});

test("identifiant inconnu refusé", () => {
  const { broker } = setup();
  assert.equal(broker.answer("6f1c2a3b-4d5e-4f60-8a7b-000000000000", "allow"), false);
});

test("pas de réponse à temps : refus", async () => {
  const { broker, resolved } = setup(20);
  assert.equal(await broker.request(SESSION, ASK, new AbortController().signal), "deny");
  assert.equal(resolved[0]?.[1], "timeout");
});

test("une réponse après l'échéance est refusée, même si le minuteur est en retard", async () => {
  const { broker, requests, resolved } = setup(60_000);
  const pending = broker.request(SESSION, ASK, new AbortController().signal);
  const req = requests[0]!;
  req.expiresAt = Date.now() - 1; // simule l'échéance dépassée
  assert.equal(broker.answer(req.requestId, "allow"), false);
  assert.equal(await pending, "deny");
  assert.equal(resolved[0]?.[1], "timeout");
});

test("annulation : signal, session arrêtée, arrêt du daemon", async () => {
  const { broker, requests, resolved } = setup();
  const ctrl = new AbortController();
  const a = broker.request(SESSION, ASK, ctrl.signal);
  ctrl.abort();
  assert.equal(await a, "deny");

  const b = broker.request(SESSION, ASK, new AbortController().signal);
  const other = broker.request("0f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", ASK, new AbortController().signal);
  broker.cancelSession(SESSION);
  assert.equal(await b, "deny");
  assert.equal(broker.list().length, 1);
  broker.cancelAll();
  assert.equal(await other, "deny");
  assert.deepEqual(
    resolved.map(([, o]) => o),
    ["cancelled", "cancelled", "cancelled"],
  );
  assert.equal(requests.length, 3);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await broker.request(SESSION, ASK, aborted.signal), "deny");
  assert.equal(requests.length, 3);
});

test("une entrée non représentable en JSON est refusée sans être publiée", async () => {
  const { broker, requests } = setup();
  const ask = { ...ASK, input: { f: () => 1 } as Record<string, unknown> };
  assert.equal(await broker.request(SESSION, ask, new AbortController().signal), "deny");
  assert.equal(requests.length, 0);
});

test("le handler SDK n'autorise que sur décision explicite, sans modifier l'entrée", async () => {
  const signal = new AbortController().signal;
  const options = { signal, toolUseID: "t1", requestId: "r1" };
  const events = (decide: () => Promise<"allow" | "deny">): SessionEvents => ({
    onInit() {},
    onDelta() {},
    onAssistantText() {},
    onTurnEnd() {},
    onExit() {},
    requestPermission: decide,
  });

  const allow = await permissionHandler(events(async () => "allow"))("Bash", { command: "ls" }, options);
  assert.deepEqual(allow, { behavior: "allow" });

  const deny = await permissionHandler(events(async () => "deny"))("Bash", { command: "ls" }, options);
  assert.equal(deny?.behavior, "deny");

  const failing = await permissionHandler(events(() => Promise.reject(new Error("x"))))("Bash", {}, options);
  assert.equal(failing?.behavior, "deny");

  let asked = false;
  const question = await permissionHandler(
    events(async () => {
      asked = true;
      return "allow";
    }),
  )("AskUserQuestion", {}, options);
  assert.equal(question?.behavior, "deny");
  assert.equal(asked, false);
});

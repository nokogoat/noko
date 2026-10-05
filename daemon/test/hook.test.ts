import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildMessage, hookOutput } from "../../hooks/hook-message.ts";
import { Daemon } from "../src/daemon.ts";
import { SessionStore } from "../src/session-store.ts";

const HOOK = join(import.meta.dirname, "..", "..", "hooks", "noko-hook.ts");

const base = { session_id: "abc-123", cwd: "/srv/projet" };

test("événements de Claude Code traduits pour le daemon", () => {
  const cases: [Record<string, unknown>, string | null][] = [
    [{ hook_event_name: "SessionStart", source: "startup" }, "session_start"],
    [{ hook_event_name: "UserPromptSubmit" }, "prompt"],
    [{ hook_event_name: "Stop" }, "stop"],
    [{ hook_event_name: "StopFailure" }, "stop"],
    [{ hook_event_name: "Notification", notification_type: "idle_prompt" }, "idle"],
    [{ hook_event_name: "Notification", notification_type: "permission_prompt" }, null],
    [{ hook_event_name: "SessionEnd" }, "session_end"],
    [{ hook_event_name: "PostToolUse" }, null],
  ];
  for (const [input, event] of cases) {
    const msg = buildMessage({ ...base, ...input } as never, 4242);
    assert.equal(msg?.type === "hook.event" ? msg.event : null, event, JSON.stringify(input));
  }
});

test("demande d'autorisation : entrée exacte, pid du parent", () => {
  const msg = buildMessage(
    { ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } },
    4242,
  );
  assert.deepEqual(msg, {
    type: "hook.permission",
    claudeSessionId: "abc-123",
    cwd: "/srv/projet",
    pid: 4242,
    toolName: "Bash",
    input: { command: "rm -rf build" },
  });
  // pid 1 (parent disparu, adopté par init) : inconnu.
  const orphan = buildMessage({ ...base, hook_event_name: "Stop" }, 1);
  assert.equal(orphan?.pid, null);
});

test("entrée inattendue : aucun message (le terminal décide)", () => {
  for (const input of [
    { ...base, session_id: "../../etc/passwd", hook_event_name: "Stop" },
    { ...base, cwd: "relatif", hook_event_name: "Stop" },
    { ...base, hook_event_name: "PermissionRequest", tool_input: { command: "ls" } },
  ]) {
    assert.equal(buildMessage(input as never, 4242), null, JSON.stringify(input));
  }
});

test("sortie : allow et deny explicites, rien pour « ask »", () => {
  assert.deepEqual(hookOutput("allow"), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  const deny = hookOutput("deny") as { hookSpecificOutput: { decision: { behavior: string } } };
  assert.equal(deny.hookSpecificOutput.decision.behavior, "deny");
  assert.equal(hookOutput("ask"), null);
});

// --- Bout à bout : le vrai script, lancé comme par Claude Code -----------------

let dir: string;
let daemon: Daemon | null;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noko-hook-"));
  store = new SessionStore(join(dir, "data"));
  daemon = null;
});

afterEach(async () => {
  await daemon?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startDaemon(): Promise<void> {
  daemon = new Daemon(
    join(dir, "noko.sock"),
    {
      startSession: () => {
        throw new Error("pas de session SDK dans ce test");
      },
      loadHistory: async () => [],
      store,
      terminal: { isAlive: () => true, ownedByUser: () => true, focus: async () => true },
    },
    { terminalPermissionTimeoutMs: 2000 },
  );
  await daemon.start();
}

interface HookRun {
  code: number | null;
  stdout: string;
  ms: number;
}

function runHook(input: unknown, env: Record<string, string> = {}): Promise<HookRun> {
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK], {
    env: { PATH: process.env.PATH ?? "", XDG_RUNTIME_DIR: dir, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stdin.end(JSON.stringify(input));
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stdout, ms: Date.now() - started }));
  });
}

/** UI de test : répond à la première demande d'autorisation reçue. */
async function answerFirstRequest(decision: "allow" | "deny"): Promise<net.Socket> {
  const sock = net.connect(join(dir, "noko.sock"));
  let buffer = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl)) as { type: string; request?: { requestId: string } };
      buffer = buffer.slice(nl + 1);
      if (msg.type === "permission.request") {
        sock.write(JSON.stringify({ type: "permission.answer", requestId: msg.request!.requestId, decision }) + "\n");
      }
    }
  });
  await new Promise((resolve) => sock.once("connect", resolve));
  return sock;
}

const permission = {
  ...base,
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf build" },
};

test("hook : daemon absent → sortie immédiate, sans décision", async () => {
  const run = await runHook(permission);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.ms < 2000, `${run.ms} ms`);
});

test("hook : XDG_RUNTIME_DIR absent ou entrée illisible → sans décision", async () => {
  await startDaemon();
  for (const [input, env] of [
    [permission, { XDG_RUNTIME_DIR: "" }],
    ["pas un objet", {}],
  ] as const) {
    const run = await runHook(input, env);
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "");
  }
});

test("hook : autorisé dans le panneau → allow ; refusé → deny", async () => {
  await startDaemon();
  for (const decision of ["allow", "deny"] as const) {
    const ui = await answerFirstRequest(decision);
    const run = await runHook(permission);
    ui.destroy();
    assert.equal(run.code, 0);
    const output = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; decision: { behavior: string } } };
    assert.equal(output.hookSpecificOutput.hookEventName, "PermissionRequest");
    assert.equal(output.hookSpecificOutput.decision.behavior, decision);
  }
});

test("hook : pas de réponse à temps → sans décision, le terminal demande", async () => {
  await startDaemon();
  const run = await runHook(permission);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
});

test("hook : session lancée par noko → ignorée, rien n'est envoyé", async () => {
  await startDaemon();
  const run = await runHook(permission, { NOKO_MANAGED: "1" });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  assert.deepEqual(store.load(), []);
});

test("hook : un événement crée la session terminal", async () => {
  await startDaemon();
  const run = await runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "secret" });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  const [session] = store.load();
  assert.equal(session?.source, "terminal");
  assert.equal(session?.claudeSessionId, "abc-123");
});

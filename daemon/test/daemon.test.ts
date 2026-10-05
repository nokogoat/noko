import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { SessionEvents, StartSession } from "../src/claude-session.ts";
import { Daemon, type DaemonDeps } from "../src/daemon.ts";
import type { LoadHistory } from "../src/history.ts";
import { SessionStore } from "../src/session-store.ts";
import { SocketPathError } from "../src/ipc-server.ts";
import type { TerminalDeps } from "../src/terminal.ts";

/** Client de test : envoie des lignes brutes et attend des messages. */
class Client {
  readonly sock: net.Socket;
  private buffer = "";
  private readonly received: ServerMessage[] = [];
  private readonly waiters: (() => void)[] = [];
  closed = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        this.received.push(JSON.parse(this.buffer.slice(0, nl)) as ServerMessage);
        this.buffer = this.buffer.slice(nl + 1);
      }
      this.notify();
    });
    sock.on("close", () => {
      this.closed = true;
      this.notify();
    });
    sock.on("error", () => {});
  }

  static connect(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(path, () => resolve(new Client(sock)));
      sock.once("error", reject);
    });
  }

  send(msg: unknown): void {
    this.sock.write(JSON.stringify(msg) + "\n");
  }

  /** Attend (et consomme) le premier message qui vérifie le prédicat. */
  async next<T extends ServerMessage["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const i = this.received.findIndex((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
      if (i !== -1) return this.received.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      if (this.closed) throw new Error(`connexion fermée avant ${type}`);
      await this.wait();
    }
  }

  async waitClosed(): Promise<void> {
    while (!this.closed) await this.wait();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 2000);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

/** Fausse session Claude : le test pilote les événements à la main. */
interface FakeSession {
  cwd: string;
  prompt: string;
  promptImages: number;
  sentImages: number[];
  resume: string | undefined;
  sent: string[];
  stopped: boolean;
  events: SessionEvents;
}

let dir: string;
let path: string;
let daemon: Daemon;
let fakes: FakeSession[];
let store: SessionStore;
const startFake: StartSession = ({ cwd, prompt, resume, events }) => {
  const fake: FakeSession = {
    cwd,
    prompt: prompt.text,
    promptImages: prompt.images.length,
    resume,
    sent: [],
    sentImages: [],
    stopped: false,
    events,
  };
  fakes.push(fake);
  return {
    send: (message) => {
      fake.sent.push(message.text);
      fake.sentImages.push(message.images.length);
    },
    stop: () => {
      fake.stopped = true;
    },
  };
};

const fakeHistory: LoadHistory = async (claudeSessionId) => {
  if (claudeSessionId === "casse") throw new Error("illisible");
  return [
    { role: "user", text: "question" },
    { role: "assistant", text: "réponse" },
  ];
};

/** Faux processus de terminal : vivants tant qu'ils sont dans `alivePids`. */
let alivePids: Set<number>;
let focused: number[];
const fakeTerminal: TerminalDeps = {
  isAlive: (pid) => alivePids.has(pid),
  ownedByUser: (pid) => alivePids.has(pid),
  focus: async (pid) => {
    focused.push(pid);
    return true;
  },
};

const deps = (): DaemonDeps => ({ startSession: startFake, loadHistory: fakeHistory, store, terminal: fakeTerminal });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "noko-test-"));
  path = join(dir, "noko.sock");
  fakes = [];
  alivePids = new Set([4242]);
  focused = [];
  store = new SessionStore(join(dir, "data"));
  daemon = new Daemon(path, deps(), { limits: { maxConnections: 3, maxLineBytes: 4096 } });
  await daemon.start();
});

afterEach(async () => {
  await daemon.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("la socket est créée en 0600 et supprimée à l'arrêt", async () => {
  const st = lstatSync(path);
  assert.ok(st.isSocket());
  assert.equal(st.mode & 0o777, 0o600);
  await daemon.stop();
  assert.throws(() => lstatSync(path), { code: "ENOENT" });
});

test("refuse de démarrer si un daemon tourne déjà", async () => {
  const second = new Daemon(path, deps());
  await assert.rejects(second.start(), SocketPathError);
  // Le premier daemon répond toujours.
  const c = await Client.connect(path);
  c.send({ type: "state.get" });
  await c.next("state.snapshot");
  c.sock.destroy();
});

test("supprime une socket morte et refuse un fichier ordinaire", async () => {
  await daemon.stop();
  // Socket morte : un processus tué net (SIGKILL) laisse son fichier de socket derrière lui.
  const child = spawn(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("ok"))`,
  ]);
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.ok(lstatSync(path).isSocket());
  daemon = new Daemon(path, deps());
  await daemon.start();
  await daemon.stop();

  writeFileSync(path, "");
  daemon = new Daemon(path, deps());
  await assert.rejects(daemon.start(), SocketPathError);
  rmSync(path);
  daemon = new Daemon(path, deps());
  await daemon.start();
});

test("state.get renvoie un instantané vide au départ", async () => {
  const c = await Client.connect(path);
  c.send({ type: "state.get" });
  assert.deepEqual(await c.next("state.snapshot"), { type: "state.snapshot", sessions: [], permissions: [], questions: [] });
  c.sock.destroy();
});

test("un message invalide renvoie une erreur et ferme la connexion", async () => {
  for (const line of ["pas du json", JSON.stringify({ type: "inconnu" }), JSON.stringify({ type: "state.get", x: 1 })]) {
    const c = await Client.connect(path);
    c.sock.write(line + "\n");
    const err = await c.next("error");
    assert.equal(err.code, "invalid_message");
    await c.waitClosed();
  }
});

test("une ligne trop longue ferme la connexion", async () => {
  const c = await Client.connect(path);
  c.sock.write("x".repeat(5000));
  await c.waitClosed();
});

test("le nombre de connexions est borné", async () => {
  const clients = await Promise.all([1, 2, 3].map(() => Client.connect(path)));
  const extra = await Client.connect(path);
  await extra.waitClosed();
  for (const c of clients) {
    c.send({ type: "state.get" });
    await c.next("state.snapshot");
    c.sock.destroy();
  }
});

test("cycle de vie d'une session", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "bonjour", name: "essai" });
  const created = await c.next("session.update", (m) => m.session.status === "starting");
  const id = created.session.id;
  assert.equal(created.session.name, "essai");
  assert.equal(fakes.length, 1);
  const fake = fakes[0]!;
  assert.equal(fake.prompt, "bonjour");

  fake.events.onInit("claude-session-1");
  const running = await c.next("session.update", (m) => m.session.status === "running");
  assert.equal(running.session.claudeSessionId, "claude-session-1");

  fake.events.onDelta("Sal");
  fake.events.onDelta("ut");
  assert.equal((await c.next("message.delta")).text, "Sal");
  assert.equal((await c.next("message.delta")).text, "ut");
  fake.events.onAssistantText("Salut");
  assert.equal((await c.next("message.complete")).text, "Salut");
  fake.events.onTurnEnd(false);
  await c.next("session.update", (m) => m.session.status === "idle");

  c.send({ type: "session.send", sessionId: id, text: "encore" });
  await c.next("session.update", (m) => m.session.status === "running");
  assert.deepEqual(fake.sent, ["encore"]);

  c.send({ type: "session.stop", sessionId: id });
  await c.next("session.update", (m) => m.session.status === "stopped");
  assert.ok(fake.stopped);

  // Les événements tardifs d'une session arrêtée sont ignorés.
  fake.events.onDelta("trop tard");
  c.send({ type: "session.send", sessionId: id, text: "x" });
  assert.equal((await c.next("error")).code, "session_closed");

  c.send({ type: "state.get" });
  const snap = await c.next("state.snapshot");
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0]!.status, "stopped");
  c.sock.destroy();
});

test("erreurs : dossier introuvable, session inconnue, fin sur erreur", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: join(dir, "absent"), prompt: "x" });
  assert.equal((await c.next("error")).code, "invalid_cwd");
  c.send({ type: "session.stop", sessionId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" });
  assert.equal((await c.next("error")).code, "unknown_session");

  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  await c.next("session.update", (m) => m.session.status === "starting");
  fakes[0]!.events.onExit(new Error("boom"));
  await c.next("session.update", (m) => m.session.status === "error");
  c.sock.destroy();
});

test("le message de l'utilisateur est renvoyé à toutes les UI", async () => {
  const a = await Client.connect(path);
  const b = await Client.connect(path);
  a.send({ type: "session.create", cwd: dir, prompt: "premier" });
  assert.equal((await b.next("message.user")).text, "premier");
  const id = (await a.next("session.update")).session.id;
  fakes[0]!.events.onInit("c1");
  a.send({ type: "session.send", sessionId: id, text: "second" });
  assert.equal((await b.next("message.user", (m) => m.text === "second")).sessionId, id);
  a.sock.destroy();
  b.sock.destroy();
});

test("reprise d'une session arrêtée", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  const id = (await c.next("session.update")).session.id;
  const first = fakes[0]!;
  first.events.onInit("claude-1");
  c.send({ type: "session.stop", sessionId: id });
  await c.next("session.update", (m) => m.session.status === "stopped");

  c.send({ type: "session.resume", sessionId: id, text: "on reprend" });
  await c.next("session.update", (m) => m.session.status === "starting" && m.session.id === id);
  assert.equal(fakes.length, 2);
  const second = fakes[1]!;
  assert.equal(second.resume, "claude-1");
  assert.equal(second.prompt, "on reprend");

  // Les événements de l'exécution précédente n'ont plus d'effet.
  first.events.onExit(new Error("tardif"));
  second.events.onInit("claude-1");
  await c.next("session.update", (m) => m.session.status === "running");
  c.send({ type: "state.get" });
  assert.equal((await c.next("state.snapshot")).sessions[0]!.status, "running");

  // Reprendre une session active revient à lui envoyer le message.
  c.send({ type: "session.resume", sessionId: id, text: "encore" });
  await c.next("message.user", (m) => m.text === "encore");
  assert.deepEqual(second.sent, ["encore"]);
  assert.equal(fakes.length, 2);
  c.sock.destroy();
});

test("une session sans identifiant Claude ne peut pas être reprise", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  const id = (await c.next("session.update")).session.id;
  c.send({ type: "session.stop", sessionId: id });
  await c.next("session.update", (m) => m.session.status === "stopped");
  c.send({ type: "session.resume", sessionId: id, text: "y" });
  assert.equal((await c.next("error")).code, "not_resumable");
  c.sock.destroy();
});

test("la liste des sessions survit à un redémarrage du daemon", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x", name: "persistante" });
  const id = (await c.next("session.update")).session.id;
  fakes[0]!.events.onInit("claude-p");
  await c.next("session.update", (m) => m.session.status === "running");
  c.sock.destroy();

  await daemon.stop();
  store.close();
  store = new SessionStore(join(dir, "data"));
  daemon = new Daemon(path, deps());
  await daemon.start();

  const d = await Client.connect(path);
  d.send({ type: "state.get" });
  const [session] = (await d.next("state.snapshot")).sessions;
  assert.equal(session?.id, id);
  assert.equal(session?.name, "persistante");
  assert.equal(session?.claudeSessionId, "claude-p");
  assert.equal(session?.status, "stopped");
  d.sock.destroy();
});

test("historique d'une session", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  const id = (await c.next("session.update")).session.id;

  // Pas encore d'identifiant Claude : historique vide.
  c.send({ type: "session.history", sessionId: id });
  assert.deepEqual((await c.next("session.history")).messages, []);

  fakes[0]!.events.onInit("claude-h");
  c.send({ type: "session.history", sessionId: id });
  const history = await c.next("session.history");
  assert.equal(history.sessionId, id);
  assert.deepEqual(history.messages, [
    { role: "user", text: "question" },
    { role: "assistant", text: "réponse" },
  ]);

  c.send({ type: "session.create", cwd: dir, prompt: "y" });
  const other = (await c.next("session.update", (m) => m.session.id !== id)).session.id;
  fakes[1]!.events.onInit("casse");
  c.send({ type: "session.history", sessionId: other });
  assert.equal((await c.next("error")).code, "history_unavailable");
  c.sock.destroy();
});

test("permissions : demande, réponse unique, instantané et annulation", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  const id = (await c.next("session.update")).session.id;
  const fake = fakes[0]!;
  fake.events.onInit("claude-perm");

  const decision = fake.events.requestPermission(
    { toolName: "Bash", input: { command: "rm -rf build" }, title: "Claude veut lancer une commande", reason: null, blockedPath: null },
    new AbortController().signal,
  );
  const { request } = await c.next("permission.request");
  assert.equal(request.sessionId, id);
  assert.deepEqual(request.input, { command: "rm -rf build" });

  // Une UI qui (re)démarre voit la demande en attente.
  c.send({ type: "state.get" });
  assert.deepEqual((await c.next("state.snapshot")).permissions, [request]);

  c.send({ type: "permission.answer", requestId: request.requestId, decision: "allow" });
  assert.equal(await decision, "allow");
  assert.equal((await c.next("permission.resolved")).outcome, "allowed");

  c.send({ type: "permission.answer", requestId: request.requestId, decision: "allow" });
  assert.equal((await c.next("error")).code, "unknown_request");

  // Arrêter la session refuse ses demandes en attente.
  const pending = fake.events.requestPermission(
    { toolName: "Write", input: { file_path: "/srv/x", content: "y" }, title: null, reason: null, blockedPath: null },
    new AbortController().signal,
  );
  await c.next("permission.request");
  c.send({ type: "session.stop", sessionId: id });
  assert.equal(await pending, "deny");
  assert.equal((await c.next("permission.resolved")).outcome, "cancelled");

  // Une session terminée ne peut plus rien demander.
  assert.equal(
    await fake.events.requestPermission(
      { toolName: "Bash", input: {}, title: null, reason: null, blockedPath: null },
      new AbortController().signal,
    ),
    "deny",
  );
  c.sock.destroy();
});

test("permissions : entrée trop grosse pour être affichée → refus immédiat", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  await c.next("session.update");
  const huge = { file_path: "/srv/x", content: "y".repeat(800 * 1024) };
  const decision = await fakes[0]!.events.requestPermission(
    { toolName: "Write", input: huge, title: null, reason: null, blockedPath: null },
    new AbortController().signal,
  );
  assert.equal(decision, "deny");
  c.send({ type: "state.get" });
  assert.deepEqual((await c.next("state.snapshot")).permissions, []);
  c.sock.destroy();
});

test("permissions : avant/après d'une modification, en plus de l'entrée exacte", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  await c.next("session.update");
  const file = join(dir, "notes.txt");
  writeFileSync(file, "a\nb\n");
  const input = { file_path: file, old_string: "b", new_string: "c" };
  void fakes[0]!.events.requestPermission(
    { toolName: "Edit", input, title: null, reason: null, blockedPath: null },
    new AbortController().signal,
  );
  const { request } = await c.next("permission.request");
  assert.deepEqual(request.input, input);
  assert.deepEqual(request.diff, {
    path: file,
    kind: "edit",
    truncated: false,
    hunks: [{ oldStart: 1, newStart: 1, lines: [" a", "-b", "+c"] }],
  });
  c.sock.destroy();
});

test("activité, outils et consommation sont diffusés sans être enregistrés", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  const id = (await c.next("session.update")).session.id;
  const fake = fakes[0]!;
  fake.events.onInit("claude-a");
  assert.deepEqual((await c.next("session.update", (m) => m.session.status === "running")).session.activity, {
    kind: "thinking",
  });

  fake.events.onActivity({ kind: "tool", tool: "Bash" });
  await c.next("session.update", (m) => m.session.activity?.kind === "tool");
  fake.events.onToolUse("Bash : ls");
  assert.equal((await c.next("message.tool")).text, "Bash : ls");

  const usage = { contextTokens: 1200, contextWindow: 200000, outputTokens: 50, costUsd: 0.01 };
  fake.events.onUsage(usage);
  assert.deepEqual((await c.next("session.update", (m) => m.session.usage !== null)).session.usage, usage);

  // Pendant une demande d'autorisation, l'activité l'indique, puis revient.
  const decision = fake.events.requestPermission(
    { toolName: "Bash", input: { command: "rm x" }, title: null, reason: null, blockedPath: null },
    new AbortController().signal,
  );
  await c.next("session.update", (m) => m.session.activity?.kind === "permission");
  const { request } = await c.next("permission.request");
  c.send({ type: "permission.answer", requestId: request.requestId, decision: "deny" });
  await decision;
  await c.next("session.update", (m) => m.session.activity?.kind === "tool");

  fake.events.onTurnEnd(false);
  assert.equal((await c.next("session.update", (m) => m.session.status === "idle")).session.activity, null);

  // L'activité et la consommation ne sont pas persistées.
  assert.deepEqual(
    store.load().map((s) => [s.id, s.activity, s.usage]),
    [[id, null, null]],
  );
  c.sock.destroy();
});

test("images jointes : transmises à la session, seul leur nombre est renvoyé aux UI", async () => {
  const png = { mediaType: "image/png", data: "iVBORw0KGgo=" };
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "regarde", images: [png, png] });
  const echo = await c.next("message.user");
  assert.equal(echo.imageCount, 2);
  assert.equal(JSON.stringify(echo).includes(png.data), false);
  const id = (await c.next("session.update")).session.id;
  assert.equal(fakes[0]!.promptImages, 2);

  fakes[0]!.events.onInit("claude-img");
  c.send({ type: "session.send", sessionId: id, text: "et celle-ci", images: [png] });
  assert.equal((await c.next("message.user", (m) => m.text === "et celle-ci")).imageCount, 1);
  assert.deepEqual(fakes[0]!.sentImages, [1]);
  c.sock.destroy();
});

test("images invalides : connexion fermée", async () => {
  for (const images of [
    [{ mediaType: "image/svg+xml", data: "AAAA" }],
    [{ mediaType: "image/png", data: "pas du base64 !" }],
    Array.from({ length: 5 }, () => ({ mediaType: "image/png", data: "AAAA" })),
  ]) {
    const c = await Client.connect(path);
    c.send({ type: "session.create", cwd: dir, prompt: "x", images });
    assert.equal((await c.next("error")).code, "invalid_message");
    await c.waitClosed();
  }
  assert.equal(fakes.length, 0);
});

test("questions : réponses validées, usage unique, abandon et annulation", async () => {
  const c = await Client.connect(path);
  c.send({ type: "session.create", cwd: dir, prompt: "x" });
  const id = (await c.next("session.update")).session.id;
  const fake = fakes[0]!;
  fake.events.onInit("claude-q");
  const questions = [
    { question: "Quel langage ?", header: "Langage", multiSelect: false, options: [{ label: "TS", description: "" }, { label: "Rust", description: "" }] },
    { question: "Quels tests ?", header: "Tests", multiSelect: true, options: [{ label: "Unitaires", description: "" }, { label: "E2E", description: "" }] },
  ];

  const pending = fake.events.askQuestions(questions, new AbortController().signal);
  await c.next("session.update", (m) => m.session.activity?.kind === "question");
  const { request } = await c.next("question.request");
  assert.equal(request.sessionId, id);
  assert.deepEqual(request.questions, questions);
  c.send({ type: "state.get" });
  assert.deepEqual((await c.next("state.snapshot")).questions, [request]);

  // Réponses incomplètes ou en trop : refusées, la question reste ouverte.
  c.send({ type: "question.answer", requestId: request.requestId, answers: { "Quel langage ?": "TS" } });
  assert.equal((await c.next("error")).code, "invalid_answers");
  c.send({
    type: "question.answer",
    requestId: request.requestId,
    answers: { "Quel langage ?": "TS", "Quels tests ?": "E2E", "Autre ?": "x" },
  });
  assert.equal((await c.next("error")).code, "invalid_answers");

  const answers = { "Quel langage ?": "TS", "Quels tests ?": "Unitaires, E2E" };
  c.send({ type: "question.answer", requestId: request.requestId, answers });
  assert.deepEqual(await pending, answers);
  assert.equal((await c.next("question.resolved")).outcome, "answered");
  c.send({ type: "question.answer", requestId: request.requestId, answers });
  assert.equal((await c.next("error")).code, "unknown_request");

  // Ignorer : aucune réponse transmise.
  const dismissed = fake.events.askQuestions(questions, new AbortController().signal);
  const second = (await c.next("question.request")).request;
  c.send({ type: "question.dismiss", requestId: second.requestId });
  assert.equal(await dismissed, null);
  assert.equal((await c.next("question.resolved")).outcome, "dismissed");

  // Arrêter la session abandonne ses questions.
  const cancelled = fake.events.askQuestions(questions, new AbortController().signal);
  await c.next("question.request");
  c.send({ type: "session.stop", sessionId: id });
  assert.equal(await cancelled, null);
  assert.equal((await c.next("question.resolved")).outcome, "cancelled");
  c.sock.destroy();
});

// --- Sessions lancées dans un terminal (hooks) -------------------------------

const hook = (claudeSessionId: string, extra: Record<string, unknown>) => ({
  claudeSessionId,
  cwd: "/srv/projet",
  pid: 4242,
  ...extra,
});

test("terminal : cycle de vie suivi par les hooks, pilotage refusé tant qu'elle tourne", async () => {
  const ui = await Client.connect(path);
  const h = await Client.connect(path);
  h.send({ type: "hook.event", ...hook("term-1", { cwd: dir, event: "session_start" }) });
  const seen = await ui.next("session.update");
  assert.equal(seen.session.source, "terminal");
  assert.equal(seen.session.status, "idle");
  assert.equal(seen.session.claudeSessionId, "term-1");
  assert.equal(seen.session.name, basename(dir));
  const id = seen.session.id;

  h.send({ type: "hook.event", ...hook("term-1", { cwd: dir, event: "prompt" }) });
  await ui.next("session.update", (m) => m.session.status === "running");
  h.send({ type: "hook.event", ...hook("term-1", { cwd: dir, event: "stop" }) });
  await ui.next("session.update", (m) => m.session.status === "idle");

  // La connexion d'un hook ne reçoit pas les diffusions.
  ui.send({ type: "state.get" });
  await ui.next("state.snapshot");
  assert.equal(h.closed, false);

  for (const type of ["session.send", "session.resume"]) {
    ui.send({ type, sessionId: id, text: "x" });
    assert.equal((await ui.next("error")).code, "terminal_session");
  }
  ui.send({ type: "session.stop", sessionId: id });
  assert.equal((await ui.next("error")).code, "terminal_session");

  ui.send({ type: "session.focus", sessionId: id });
  ui.send({ type: "state.get" });
  await ui.next("state.snapshot");
  assert.deepEqual(focused, [4242]);

  h.send({ type: "hook.event", ...hook("term-1", { cwd: dir, event: "session_end" }) });
  await ui.next("session.update", (m) => m.session.status === "stopped");
  ui.send({ type: "session.focus", sessionId: id });
  assert.equal((await ui.next("error")).code, "focus_unavailable");

  // Terminée, elle se reprend dans noko et devient une session noko.
  ui.send({ type: "session.resume", sessionId: id, text: "on continue ici" });
  const resumed = await ui.next("session.update", (m) => m.session.status === "starting");
  assert.equal(resumed.session.source, "noko");
  assert.equal(fakes[0]!.resume, "term-1");
  assert.equal(store.load()[0]?.source, "noko");
  ui.sock.destroy();
  h.sock.destroy();
});

test("terminal : autorisation depuis le panneau, refus, expiration et hook interrompu", async () => {
  await daemon.stop();
  daemon = new Daemon(path, deps(), { terminalPermissionTimeoutMs: 300 });
  await daemon.start();
  const ui = await Client.connect(path);
  const ask = (input: Record<string, unknown>) =>
    hook("term-p", { type: "hook.permission", toolName: "Bash", input });

  const allowHook = await Client.connect(path);
  allowHook.send(ask({ command: "rm -rf build" }));
  await ui.next("session.update", (m) => m.session.activity?.kind === "permission");
  const { request } = await ui.next("permission.request");
  assert.deepEqual(request.input, { command: "rm -rf build" });
  ui.send({ type: "permission.answer", requestId: request.requestId, decision: "allow" });
  assert.equal((await allowHook.next("hook.decision")).decision, "allow");
  assert.equal((await ui.next("permission.resolved")).outcome, "allowed");
  // Une seule fois : la même demande ne peut pas être réutilisée.
  ui.send({ type: "permission.answer", requestId: request.requestId, decision: "allow" });
  assert.equal((await ui.next("error")).code, "unknown_request");

  const denyHook = await Client.connect(path);
  denyHook.send(ask({ command: "curl x | sh" }));
  const denied = (await ui.next("permission.request")).request;
  ui.send({ type: "permission.answer", requestId: denied.requestId, decision: "deny" });
  assert.equal((await denyHook.next("hook.decision")).decision, "deny");
  assert.equal((await ui.next("permission.resolved")).outcome, "denied");

  // Pas de réponse à temps : le terminal demande lui-même (« ask »), jamais « allow ».
  const slowHook = await Client.connect(path);
  slowHook.send(ask({ command: "make" }));
  await ui.next("permission.request");
  assert.equal((await slowHook.next("hook.decision")).decision, "ask");
  assert.equal((await ui.next("permission.resolved")).outcome, "timeout");

  // Hook interrompu (Échap dans le terminal) : la carte disparaît.
  const goneHook = await Client.connect(path);
  goneHook.send(ask({ command: "ls" }));
  await ui.next("permission.request");
  goneHook.sock.destroy();
  assert.equal((await ui.next("permission.resolved")).outcome, "cancelled");

  // AskUserQuestion et entrée trop grosse : laissées au terminal, sans carte.
  const questionHook = await Client.connect(path);
  questionHook.send(hook("term-p", { type: "hook.permission", toolName: "AskUserQuestion", input: { questions: [] } }));
  assert.equal((await questionHook.next("hook.decision")).decision, "ask");
  ui.send({ type: "state.get" });
  assert.deepEqual((await ui.next("state.snapshot")).permissions, []);
  for (const c of [ui, allowHook, denyHook, slowHook, questionHook]) c.sock.destroy();
});

test("terminal : les hooks d'une session pilotée par noko sont ignorés", async () => {
  const ui = await Client.connect(path);
  ui.send({ type: "session.create", cwd: dir, prompt: "x" });
  await ui.next("session.update");
  fakes[0]!.events.onInit("noko-run");
  await ui.next("session.update", (m) => m.session.status === "running");

  const h = await Client.connect(path);
  h.send({ type: "hook.event", ...hook("noko-run", { event: "stop" }) });
  h.send(hook("noko-run", { type: "hook.permission", toolName: "Bash", input: { command: "ls" } }));
  assert.equal((await h.next("hook.decision")).decision, "ask");
  ui.send({ type: "state.get" });
  const snap = await ui.next("state.snapshot");
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0]!.status, "running");
  assert.equal(snap.sessions[0]!.source, "noko");
  assert.deepEqual(snap.permissions, []);
  ui.sock.destroy();
  h.sock.destroy();
});

test("terminal : processus disparu sans SessionEnd, pid d'un autre utilisateur ignoré", async () => {
  await daemon.stop();
  daemon = new Daemon(path, deps(), { terminalCheckMs: 50 });
  await daemon.start();
  const ui = await Client.connect(path);
  const h = await Client.connect(path);
  h.send({ type: "hook.event", ...hook("term-gone", { event: "prompt" }) });
  const id = (await ui.next("session.update")).session.id;
  alivePids.delete(4242);
  await ui.next("session.update", (m) => m.session.id === id && m.session.status === "stopped");

  // Pid inconnu (pas à l'utilisateur) : pas de focus possible.
  h.send({ type: "hook.event", ...hook("term-other", { event: "session_start", pid: 999 }) });
  const other = (await ui.next("session.update", (m) => m.session.claudeSessionId === "term-other")).session.id;
  ui.send({ type: "session.focus", sessionId: other });
  assert.equal((await ui.next("error")).code, "focus_unavailable");

  // La fin d'une session inconnue ne crée rien.
  h.send({ type: "hook.event", ...hook("jamais-vue", { event: "session_end" }) });
  ui.send({ type: "state.get" });
  assert.equal((await ui.next("state.snapshot")).sessions.length, 2);
  ui.sock.destroy();
  h.sock.destroy();
});

test("terminal : identifiant de session au format inattendu → connexion fermée", async () => {
  const h = await Client.connect(path);
  h.send({ type: "hook.event", event: "prompt", claudeSessionId: "../../etc", cwd: "/srv", pid: null });
  assert.equal((await h.next("error")).code, "invalid_message");
  await h.waitClosed();
});

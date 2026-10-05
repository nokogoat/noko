import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { SessionEvents, StartSession } from "../src/claude-session.ts";
import { Daemon, type DaemonDeps } from "../src/daemon.ts";
import type { LoadHistory } from "../src/history.ts";
import { SessionStore } from "../src/session-store.ts";
import { SocketPathError } from "../src/ipc-server.ts";

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

const deps = (): DaemonDeps => ({ startSession: startFake, loadHistory: fakeHistory, store });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "noko-test-"));
  path = join(dir, "noko.sock");
  fakes = [];
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
  assert.deepEqual(await c.next("state.snapshot"), { type: "state.snapshot", sessions: [], permissions: [] });
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

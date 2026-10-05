// Cœur du daemon : tient l'état des sessions et traduit les messages de l'UI
// en actions sur les sessions Claude.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import {
  type ClientMessage,
  type HookDecision,
  type SessionInfo,
  type SessionStatus,
  TERMINAL_PERMISSION_TIMEOUT_MS,
} from "../../shared/protocol.ts";
import type { RunningSession, StartSession, UserMessage } from "./claude-session.ts";
import type { LoadHistory } from "./history.ts";
import { IpcServer, type Connection, type IpcLimits } from "./ipc-server.ts";
import { errorFields, log } from "./log.ts";
import { PermissionBroker, type Decision, type PermissionAsk } from "./permissions.ts";
import { QuestionBroker } from "./questions.ts";
import type { TerminalDeps } from "./terminal.ts";

/** Persistance de la liste des sessions (SessionStore en production). */
export interface SessionPersistence {
  save(info: SessionInfo): void;
  load(): SessionInfo[];
}

export interface DaemonDeps {
  startSession: StartSession;
  loadHistory: LoadHistory;
  store: SessionPersistence;
  terminal: TerminalDeps;
}

type HookEventMessage = Extract<ClientMessage, { type: "hook.event" }>;
type HookPermissionMessage = Extract<ClientMessage, { type: "hook.permission" }>;

interface SessionRecord {
  info: SessionInfo;
  runner: RunningSession | null;
  /** Numéro de l'exécution en cours : les événements d'une exécution précédente sont ignorés. */
  run: number;
  /** Session terminal : processus `claude`, pour le focus et la détection de sa fin. */
  terminalPid: number | null;
}

const CLOSED: ReadonlySet<SessionStatus> = new Set(["stopped", "error"]);

/** Sans réponse dans ce délai, la demande d'autorisation est refusée. */
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** Sans réponse dans ce délai, les questions sont abandonnées (Claude en est informé). */
export const QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
/** Entrée d'outil trop grosse pour être affichée en entier : refusée d'office. */
const MAX_PERMISSION_INPUT_BYTES = 768 * 1024;
/** Intervalle de vérification des processus des sessions terminal. */
const TERMINAL_CHECK_MS = 10 * 1000;

export interface DaemonOptions {
  limits?: Partial<IpcLimits>;
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
  terminalPermissionTimeoutMs?: number;
  terminalCheckMs?: number;
}

function inputSize(input: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(input));
  } catch {
    return Infinity;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class Daemon {
  private readonly ipc: IpcServer;
  private readonly deps: DaemonDeps;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly permissions: PermissionBroker;
  private readonly questions: QuestionBroker;
  private readonly terminalPermissionTimeoutMs: number;
  private readonly terminalCheckMs: number;
  /** Demandes des hooks en attente, annulées si leur connexion se ferme. */
  private readonly hookRequests = new Map<Connection, AbortController>();
  private terminalCheck: NodeJS.Timeout | null = null;

  constructor(socketPath: string, deps: DaemonDeps, options: DaemonOptions = {}) {
    this.deps = deps;
    this.terminalPermissionTimeoutMs = options.terminalPermissionTimeoutMs ?? TERMINAL_PERMISSION_TIMEOUT_MS;
    this.terminalCheckMs = options.terminalCheckMs ?? TERMINAL_CHECK_MS;
    this.ipc = new IpcServer(
      socketPath,
      {
        onMessage: (conn, msg) => this.handle(conn, msg),
        // Hook interrompu (Échap, délai de Claude Code) : sa demande disparaît du panneau.
        onClose: (conn) => this.hookRequests.get(conn)?.abort(),
      },
      options.limits ?? {},
    );
    this.permissions = new PermissionBroker(options.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS, {
      onRequest: (request) => {
        log("permission.requested", { session: request.sessionId, request: request.requestId });
        this.ipc.broadcast({ type: "permission.request", request });
      },
      onResolved: (request, outcome) => {
        log("permission.resolved", { session: request.sessionId, request: request.requestId, outcome });
        this.ipc.broadcast({
          type: "permission.resolved",
          requestId: request.requestId,
          sessionId: request.sessionId,
          outcome,
        });
      },
    });
    this.questions = new QuestionBroker(options.questionTimeoutMs ?? QUESTION_TIMEOUT_MS, {
      onRequest: (request) => {
        log("question.requested", { session: request.sessionId, request: request.requestId });
        this.ipc.broadcast({ type: "question.request", request });
      },
      onResolved: (request, outcome) => {
        log("question.resolved", { session: request.sessionId, request: request.requestId, outcome });
        this.ipc.broadcast({
          type: "question.resolved",
          requestId: request.requestId,
          sessionId: request.sessionId,
          outcome,
        });
      },
    });
  }

  start(): Promise<void> {
    for (const info of this.deps.store.load()) {
      this.sessions.set(info.id, { info, runner: null, run: 0, terminalPid: null });
    }
    this.terminalCheck = setInterval(() => this.checkTerminals(), this.terminalCheckMs);
    this.terminalCheck.unref();
    return this.ipc.start();
  }

  async stop(): Promise<void> {
    if (this.terminalCheck !== null) clearInterval(this.terminalCheck);
    this.terminalCheck = null;
    this.permissions.cancelAll();
    this.questions.cancelAll();
    for (const record of this.sessions.values()) record.runner?.stop();
    await this.ipc.stop();
  }

  private async handle(conn: Connection, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "state.get":
        conn.send({
          type: "state.snapshot",
          sessions: this.snapshot(),
          permissions: this.permissions.list(),
          questions: this.questions.list(),
        });
        return;
      case "session.create":
        this.create(conn, msg.cwd, { text: msg.prompt, images: msg.images ?? [] }, msg.name);
        return;
      case "session.send": {
        const record = this.find(conn, msg.sessionId);
        if (record === null || this.inTerminal(conn, record)) return;
        if (record.runner === null || CLOSED.has(record.info.status)) {
          conn.send({ type: "error", code: "session_closed", message: "session terminée" });
          return;
        }
        this.sendUser(record, record.runner, { text: msg.text, images: msg.images ?? [] });
        return;
      }
      case "session.resume": {
        const record = this.find(conn, msg.sessionId);
        if (record === null || this.inTerminal(conn, record)) return;
        if (record.runner !== null && !CLOSED.has(record.info.status)) {
          // Déjà active : le message est simplement envoyé.
          this.sendUser(record, record.runner, { text: msg.text, images: msg.images ?? [] });
          return;
        }
        const claudeSessionId = record.info.claudeSessionId;
        if (claudeSessionId === null) {
          conn.send({ type: "error", code: "not_resumable", message: "session impossible à reprendre" });
          return;
        }
        if (!isDirectory(record.info.cwd)) {
          conn.send({ type: "error", code: "invalid_cwd", message: "dossier introuvable" });
          return;
        }
        this.launch(record, { text: msg.text, images: msg.images ?? [] }, claudeSessionId);
        log("session.resumed", { session: record.info.id });
        return;
      }
      case "session.stop": {
        const record = this.find(conn, msg.sessionId);
        if (record === null || this.inTerminal(conn, record)) return;
        const runner = record.runner;
        record.runner = null;
        this.permissions.cancelSession(record.info.id);
        this.questions.cancelSession(record.info.id);
        runner?.stop();
        this.update(record, "stopped");
        log("session.stopped", { session: record.info.id });
        return;
      }
      case "session.focus": {
        const record = this.find(conn, msg.sessionId);
        if (record === null) return;
        const pid = record.terminalPid;
        if (pid === null || !(await this.deps.terminal.focus(pid))) {
          conn.send({ type: "error", code: "focus_unavailable", message: "fenêtre du terminal introuvable" });
        }
        return;
      }
      case "hook.event":
        conn.mute();
        this.hookEvent(msg);
        return;
      case "hook.permission": {
        conn.mute();
        const decision = await this.hookPermission(conn, msg);
        conn.send({ type: "hook.decision", decision });
        return;
      }
      case "permission.answer":
        if (!this.permissions.answer(msg.requestId, msg.decision)) {
          conn.send({ type: "error", code: "unknown_request", message: "demande inconnue ou expirée" });
        }
        return;
      case "question.answer": {
        const result = this.questions.answer(msg.requestId, msg.answers);
        if (result === "unknown") {
          conn.send({ type: "error", code: "unknown_request", message: "question inconnue ou expirée" });
        } else if (result === "invalid") {
          conn.send({ type: "error", code: "invalid_answers", message: "réponses incomplètes" });
        }
        return;
      }
      case "question.dismiss":
        if (!this.questions.dismiss(msg.requestId)) {
          conn.send({ type: "error", code: "unknown_request", message: "question inconnue ou expirée" });
        }
        return;
      case "session.history": {
        const record = this.find(conn, msg.sessionId);
        if (record === null) return;
        const claudeSessionId = record.info.claudeSessionId;
        if (claudeSessionId === null) {
          conn.send({ type: "session.history", sessionId: record.info.id, messages: [] });
          return;
        }
        try {
          const messages = await this.deps.loadHistory(claudeSessionId, record.info.cwd);
          conn.send({ type: "session.history", sessionId: record.info.id, messages });
        } catch (err) {
          log("session.history_failed", { session: record.info.id, ...errorFields(err) });
          conn.send({ type: "error", code: "history_unavailable", message: "historique indisponible" });
        }
        return;
      }
    }
  }

  private create(conn: Connection, cwd: string, prompt: UserMessage, name: string | undefined): void {
    if (!isDirectory(cwd)) {
      conn.send({ type: "error", code: "invalid_cwd", message: "dossier introuvable" });
      return;
    }
    const record: SessionRecord = {
      info: {
        id: randomUUID(),
        claudeSessionId: null,
        name: name ?? (basename(cwd) || "/"),
        source: "noko",
        cwd,
        status: "starting",
        lastActivity: Date.now(),
        activity: null,
        usage: null,
      },
      runner: null,
      run: 0,
      terminalPid: null,
    };
    this.sessions.set(record.info.id, record);
    this.launch(record, prompt, undefined);
    log("session.created", { session: record.info.id });
  }

  /** Démarre (ou reprend) l'exécution d'une session avec un premier message. */
  /** Message envoyé à une session active ; renvoyé aux UI sans le contenu des images. */
  private sendUser(record: SessionRecord, runner: RunningSession, message: UserMessage): void {
    this.broadcastUser(record.info.id, message);
    runner.send(message);
    this.update(record, "running");
  }

  private broadcastUser(sessionId: string, { text, images }: UserMessage): void {
    this.ipc.broadcast({ type: "message.user", sessionId, text, imageCount: images.length });
  }

  private launch(record: SessionRecord, prompt: UserMessage, resume: string | undefined): void {
    const id = record.info.id;
    const run = ++record.run;
    // Une session terminal terminée, reprise ici, devient une session noko.
    record.info.source = "noko";
    record.terminalPid = null;
    this.update(record, "starting");
    this.broadcastUser(id, prompt);

    // Seule l'exécution en cours, tant qu'elle n'est pas terminée, peut modifier l'état.
    const live = () => record.run === run && !CLOSED.has(record.info.status);
    record.runner = this.deps.startSession({
      cwd: record.info.cwd,
      prompt,
      ...(resume !== undefined ? { resume } : {}),
      events: {
        onInit: (claudeSessionId) => {
          if (!live()) return;
          record.info.claudeSessionId = claudeSessionId;
          this.update(record, "running");
        },
        onDelta: (text) => {
          if (!live()) return;
          this.ipc.broadcast({ type: "message.delta", sessionId: id, text });
        },
        onAssistantText: (text) => {
          if (!live()) return;
          this.ipc.broadcast({ type: "message.complete", sessionId: id, text });
        },
        onTurnEnd: (isError) => {
          if (!live()) return;
          if (isError) log("session.turn_error", { session: id });
          this.update(record, "idle");
        },
        onActivity: (activity) => {
          if (!live()) return;
          record.info.activity = activity;
          this.publish(record);
        },
        onToolUse: (summary) => {
          if (!live()) return;
          this.ipc.broadcast({ type: "message.tool", sessionId: id, text: summary });
        },
        onUsage: (usage) => {
          if (!live()) return;
          record.info.usage = usage;
          this.publish(record);
        },
        askQuestions: async (questions, signal) => {
          if (!live()) return null;
          const previous = record.info.activity;
          record.info.activity = { kind: "question" };
          this.publish(record);
          const answers = await this.questions.ask(id, questions, signal);
          if (live() && record.info.activity?.kind === "question") {
            record.info.activity = previous;
            this.publish(record);
          }
          return answers;
        },
        requestPermission: async (ask, signal) => {
          if (!live()) return "deny";
          const previous = record.info.activity;
          record.info.activity = { kind: "permission" };
          this.publish(record);
          const decision = await this.requestPermission(id, ask, signal);
          if (live() && record.info.activity?.kind === "permission") {
            record.info.activity = previous;
            this.publish(record);
          }
          return decision;
        },
        onExit: (error) => {
          if (!live()) return;
          record.runner = null;
          this.permissions.cancelSession(id);
          this.questions.cancelSession(id);
          if (error === undefined) {
            log("session.exited", { session: id });
            this.update(record, "stopped");
          } else {
            log("session.failed", { session: id, ...errorFields(error) });
            this.update(record, "error");
          }
        },
      },
    });
  }

  private requestPermission(sessionId: string, ask: PermissionAsk, signal: AbortSignal): Promise<Decision> {
    if (inputSize(ask.input) > MAX_PERMISSION_INPUT_BYTES) {
      // L'UI doit montrer l'entrée exacte : si elle ne peut pas, on refuse.
      log("permission.too_large", { session: sessionId, tool: ask.toolName });
      return Promise.resolve("deny");
    }
    return this.permissions.request(sessionId, ask, signal);
  }

  // --- Sessions lancées dans un terminal (hooks) ---------------------------

  /** Session en cours dans un terminal : elle se pilote depuis le terminal, pas d'ici. */
  private inTerminal(conn: Connection, record: SessionRecord): boolean {
    if (record.info.source !== "terminal" || CLOSED.has(record.info.status)) return false;
    conn.send({ type: "error", code: "terminal_session", message: "session en cours dans un terminal" });
    return true;
  }

  /**
   * Session terminal visée par un hook, créée au besoin. null : session pilotée par noko
   * (ses demandes passent par canUseTool), ou fin d'une session inconnue.
   */
  private terminalRecord(msg: HookEventMessage | HookPermissionMessage): SessionRecord | null {
    let record: SessionRecord | undefined;
    for (const r of this.sessions.values()) {
      if (r.info.claudeSessionId === msg.claudeSessionId) record = r;
    }
    if (record !== undefined && record.runner !== null) return null;
    if (record === undefined) {
      if (msg.type === "hook.event" && msg.event === "session_end") return null;
      record = {
        info: {
          id: randomUUID(),
          claudeSessionId: msg.claudeSessionId,
          name: basename(msg.cwd) || "/",
          source: "terminal",
          cwd: msg.cwd,
          status: "idle",
          lastActivity: Date.now(),
          activity: null,
          usage: null,
        },
        runner: null,
        run: 0,
        terminalPid: null,
      };
      this.sessions.set(record.info.id, record);
      log("session.terminal_seen", { session: record.info.id });
    }
    // Reprise dans un terminal d'une session noko terminée : elle devient une session terminal.
    record.info.source = "terminal";
    if (msg.pid !== null && this.deps.terminal.ownedByUser(msg.pid)) record.terminalPid = msg.pid;
    return record;
  }

  private hookEvent(msg: HookEventMessage): void {
    const record = this.terminalRecord(msg);
    if (record === null) return;
    switch (msg.event) {
      case "session_start":
      case "stop":
      case "idle":
        this.update(record, "idle");
        return;
      case "prompt":
        this.update(record, "running");
        return;
      case "session_end":
        record.terminalPid = null;
        this.permissions.cancelSession(record.info.id);
        this.update(record, "stopped");
        return;
    }
  }

  /**
   * Demande d'autorisation d'une session terminal. « ask » (le terminal demande lui-même)
   * pour tout ce qui n'est pas une réponse explicite de l'utilisateur.
   */
  private async hookPermission(conn: Connection, msg: HookPermissionMessage): Promise<HookDecision> {
    const record = this.terminalRecord(msg);
    // Questions à choix : posées dans le terminal (pas de réponse possible par ce hook).
    if (record === null || msg.toolName === "AskUserQuestion") return "ask";
    if (inputSize(msg.input) > MAX_PERMISSION_INPUT_BYTES) {
      log("permission.too_large", { session: record.info.id, tool: msg.toolName });
      return "ask";
    }
    const controller = new AbortController();
    this.hookRequests.set(conn, controller);
    const previous = record.info.activity;
    record.info.activity = { kind: "permission" };
    this.publish(record);
    try {
      const ask = { toolName: msg.toolName, input: msg.input, title: null, reason: null, blockedPath: null };
      const decision = await this.permissions.requestAnswer(
        record.info.id,
        ask,
        controller.signal,
        this.terminalPermissionTimeoutMs,
      );
      return decision ?? "ask";
    } finally {
      this.hookRequests.delete(conn);
      if (record.info.activity?.kind === "permission") {
        record.info.activity = previous;
        this.publish(record);
      }
    }
  }

  /** Terminal fermé sans SessionEnd (fenêtre tuée…) : la session est marquée terminée. */
  private checkTerminals(): void {
    for (const record of this.sessions.values()) {
      const pid = record.terminalPid;
      if (record.info.source !== "terminal" || pid === null || this.deps.terminal.isAlive(pid)) continue;
      record.terminalPid = null;
      if (CLOSED.has(record.info.status)) continue;
      this.permissions.cancelSession(record.info.id);
      this.update(record, "stopped");
      log("session.terminal_gone", { session: record.info.id });
    }
  }

  private find(conn: Connection, sessionId: string): SessionRecord | null {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      conn.send({ type: "error", code: "unknown_session", message: "session inconnue" });
      return null;
    }
    return record;
  }

  private update(record: SessionRecord, status: SessionStatus): void {
    record.info.status = status;
    record.info.lastActivity = Date.now();
    if (status === "running") record.info.activity ??= { kind: "thinking" };
    else record.info.activity = null;
    try {
      this.deps.store.save(record.info);
    } catch (err) {
      log("store.save_failed", { session: record.info.id, ...errorFields(err) });
    }
    this.publish(record);
  }

  /** Diffuse l'état de la session sans l'enregistrer (activité, consommation). */
  private publish(record: SessionRecord): void {
    this.ipc.broadcast({ type: "session.update", session: { ...record.info } });
  }

  private snapshot(): SessionInfo[] {
    return [...this.sessions.values()].map((r) => ({ ...r.info }));
  }
}

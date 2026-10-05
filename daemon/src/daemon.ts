// Cœur du daemon : tient l'état des sessions et traduit les messages de l'UI
// en actions sur les sessions Claude.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import type { ClientMessage, SessionInfo, SessionStatus } from "../../shared/protocol.ts";
import type { RunningSession, StartSession } from "./claude-session.ts";
import type { LoadHistory } from "./history.ts";
import { IpcServer, type Connection, type IpcLimits } from "./ipc-server.ts";
import { errorFields, log } from "./log.ts";
import { PermissionBroker, type Decision, type PermissionAsk } from "./permissions.ts";

/** Persistance de la liste des sessions (SessionStore en production). */
export interface SessionPersistence {
  save(info: SessionInfo): void;
  load(): SessionInfo[];
}

export interface DaemonDeps {
  startSession: StartSession;
  loadHistory: LoadHistory;
  store: SessionPersistence;
}

interface SessionRecord {
  info: SessionInfo;
  runner: RunningSession | null;
  /** Numéro de l'exécution en cours : les événements d'une exécution précédente sont ignorés. */
  run: number;
}

const CLOSED: ReadonlySet<SessionStatus> = new Set(["stopped", "error"]);

/** Sans réponse dans ce délai, la demande d'autorisation est refusée. */
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** Entrée d'outil trop grosse pour être affichée en entier : refusée d'office. */
const MAX_PERMISSION_INPUT_BYTES = 768 * 1024;

export interface DaemonOptions {
  limits?: Partial<IpcLimits>;
  permissionTimeoutMs?: number;
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

  constructor(socketPath: string, deps: DaemonDeps, options: DaemonOptions = {}) {
    this.deps = deps;
    this.ipc = new IpcServer(
      socketPath,
      { onMessage: (conn, msg) => this.handle(conn, msg) },
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
  }

  start(): Promise<void> {
    for (const info of this.deps.store.load()) {
      this.sessions.set(info.id, { info, runner: null, run: 0 });
    }
    return this.ipc.start();
  }

  async stop(): Promise<void> {
    this.permissions.cancelAll();
    for (const record of this.sessions.values()) record.runner?.stop();
    await this.ipc.stop();
  }

  private async handle(conn: Connection, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "state.get":
        conn.send({ type: "state.snapshot", sessions: this.snapshot(), permissions: this.permissions.list() });
        return;
      case "session.create":
        this.create(conn, msg.cwd, msg.prompt, msg.name);
        return;
      case "session.send": {
        const record = this.find(conn, msg.sessionId);
        if (record === null) return;
        if (record.runner === null || CLOSED.has(record.info.status)) {
          conn.send({ type: "error", code: "session_closed", message: "session terminée" });
          return;
        }
        this.ipc.broadcast({ type: "message.user", sessionId: record.info.id, text: msg.text });
        record.runner.send(msg.text);
        this.update(record, "running");
        return;
      }
      case "session.resume": {
        const record = this.find(conn, msg.sessionId);
        if (record === null) return;
        if (record.runner !== null && !CLOSED.has(record.info.status)) {
          // Déjà active : le message est simplement envoyé.
          this.ipc.broadcast({ type: "message.user", sessionId: record.info.id, text: msg.text });
          record.runner.send(msg.text);
          this.update(record, "running");
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
        this.launch(record, msg.text, claudeSessionId);
        log("session.resumed", { session: record.info.id });
        return;
      }
      case "session.stop": {
        const record = this.find(conn, msg.sessionId);
        if (record === null) return;
        const runner = record.runner;
        record.runner = null;
        this.permissions.cancelSession(record.info.id);
        runner?.stop();
        this.update(record, "stopped");
        log("session.stopped", { session: record.info.id });
        return;
      }
      case "permission.answer":
        if (!this.permissions.answer(msg.requestId, msg.decision)) {
          conn.send({ type: "error", code: "unknown_request", message: "demande inconnue ou expirée" });
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

  private create(conn: Connection, cwd: string, prompt: string, name: string | undefined): void {
    if (!isDirectory(cwd)) {
      conn.send({ type: "error", code: "invalid_cwd", message: "dossier introuvable" });
      return;
    }
    const record: SessionRecord = {
      info: {
        id: randomUUID(),
        claudeSessionId: null,
        name: name ?? (basename(cwd) || "/"),
        cwd,
        status: "starting",
        lastActivity: Date.now(),
      },
      runner: null,
      run: 0,
    };
    this.sessions.set(record.info.id, record);
    this.launch(record, prompt, undefined);
    log("session.created", { session: record.info.id });
  }

  /** Démarre (ou reprend) l'exécution d'une session avec un premier message. */
  private launch(record: SessionRecord, prompt: string, resume: string | undefined): void {
    const id = record.info.id;
    const run = ++record.run;
    this.update(record, "starting");
    this.ipc.broadcast({ type: "message.user", sessionId: id, text: prompt });

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
        requestPermission: (ask, signal) => {
          if (!live()) return Promise.resolve<Decision>("deny");
          return this.requestPermission(id, ask, signal);
        },
        onExit: (error) => {
          if (!live()) return;
          record.runner = null;
          this.permissions.cancelSession(id);
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
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(ask.input));
    } catch {
      size = Infinity;
    }
    if (size > MAX_PERMISSION_INPUT_BYTES) {
      // L'UI doit montrer l'entrée exacte : si elle ne peut pas, on refuse.
      log("permission.too_large", { session: sessionId, tool: ask.toolName });
      return Promise.resolve("deny");
    }
    return this.permissions.request(sessionId, ask, signal);
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
    try {
      this.deps.store.save(record.info);
    } catch (err) {
      log("store.save_failed", { session: record.info.id, ...errorFields(err) });
    }
    this.ipc.broadcast({ type: "session.update", session: { ...record.info } });
  }

  private snapshot(): SessionInfo[] {
    return [...this.sessions.values()].map((r) => ({ ...r.info }));
  }
}

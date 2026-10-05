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

  constructor(socketPath: string, deps: DaemonDeps, limits: Partial<IpcLimits> = {}) {
    this.deps = deps;
    this.ipc = new IpcServer(socketPath, { onMessage: (conn, msg) => this.handle(conn, msg) }, limits);
  }

  start(): Promise<void> {
    for (const info of this.deps.store.load()) {
      this.sessions.set(info.id, { info, runner: null, run: 0 });
    }
    return this.ipc.start();
  }

  async stop(): Promise<void> {
    for (const record of this.sessions.values()) record.runner?.stop();
    await this.ipc.stop();
  }

  private async handle(conn: Connection, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "state.get":
        conn.send({ type: "state.snapshot", sessions: this.snapshot() });
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
        runner?.stop();
        this.update(record, "stopped");
        log("session.stopped", { session: record.info.id });
        return;
      }
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
        onExit: (error) => {
          if (!live()) return;
          record.runner = null;
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

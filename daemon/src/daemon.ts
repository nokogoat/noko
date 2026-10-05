// Cœur du daemon : tient l'état des sessions et traduit les messages de l'UI
// en actions sur les sessions Claude.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import type { ClientMessage, SessionInfo, SessionStatus } from "../../shared/protocol.ts";
import type { RunningSession, StartSession } from "./claude-session.ts";
import { IpcServer, type Connection, type IpcLimits } from "./ipc-server.ts";
import { errorFields, log } from "./log.ts";

interface SessionRecord {
  info: SessionInfo;
  runner: RunningSession | null;
}

const CLOSED: ReadonlySet<SessionStatus> = new Set(["stopped", "error"]);

export class Daemon {
  private readonly ipc: IpcServer;
  private readonly startSession: StartSession;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(socketPath: string, startSession: StartSession, limits: Partial<IpcLimits> = {}) {
    this.startSession = startSession;
    this.ipc = new IpcServer(socketPath, { onMessage: (conn, msg) => this.handle(conn, msg) }, limits);
  }

  start(): Promise<void> {
    return this.ipc.start();
  }

  async stop(): Promise<void> {
    for (const record of this.sessions.values()) record.runner?.stop();
    await this.ipc.stop();
  }

  private handle(conn: Connection, msg: ClientMessage): void {
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
        record.runner.send(msg.text);
        this.update(record, "running");
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
    }
  }

  private create(conn: Connection, cwd: string, prompt: string, name: string | undefined): void {
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      // isDir reste false
    }
    if (!isDir) {
      conn.send({ type: "error", code: "invalid_cwd", message: "dossier introuvable" });
      return;
    }

    const id = randomUUID();
    const record: SessionRecord = {
      info: {
        id,
        claudeSessionId: null,
        name: name ?? (basename(cwd) || "/"),
        cwd,
        status: "starting",
        lastActivity: Date.now(),
      },
      runner: null,
    };
    this.sessions.set(id, record);
    this.broadcastSession(record);
    log("session.created", { session: id });

    // Les événements d'une session terminée (ou arrêtée par l'utilisateur) sont ignorés.
    const live = () => !CLOSED.has(record.info.status);
    record.runner = this.startSession({
      cwd,
      prompt,
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
    this.broadcastSession(record);
  }

  private broadcastSession(record: SessionRecord): void {
    this.ipc.broadcast({ type: "session.update", session: { ...record.info } });
  }

  private snapshot(): SessionInfo[] {
    return [...this.sessions.values()].map((r) => ({ ...r.info }));
  }
}

// Serveur IPC : socket Unix en 0600, une ligne JSON par message, validée par zod
// dans les deux sens. Un message invalide ferme la connexion, jamais le daemon.

import { lstatSync, unlinkSync } from "node:fs";
import net from "node:net";
import {
  ClientMessage,
  MAX_LINE_BYTES,
  ServerMessage,
} from "../../shared/protocol.ts";
import { LineDecoder } from "./line-decoder.ts";
import { errorFields, log } from "./log.ts";

export class SocketPathError extends Error {
  override name = "SocketPathError";
}

export interface Connection {
  readonly id: number;
  send(msg: ServerMessage): void;
}

export interface IpcHandlers {
  onMessage(conn: Connection, msg: ClientMessage): void | Promise<void>;
}

export interface IpcLimits {
  maxConnections: number;
  maxLineBytes: number;
  /** Au-delà, le client ne lit pas assez vite : il est déconnecté. */
  maxWriteBuffer: number;
}

const DEFAULT_LIMITS: IpcLimits = {
  maxConnections: 8,
  maxLineBytes: MAX_LINE_BYTES,
  maxWriteBuffer: 16 * MAX_LINE_BYTES,
};

/** Valide et sérialise un message sortant ; null s'il est invalide ou trop gros. */
function serialize(msg: ServerMessage, maxLineBytes: number): string | null {
  const checked = ServerMessage.safeParse(msg);
  if (!checked.success) {
    log("ipc.invalid_outgoing", { type: msg.type });
    return null;
  }
  const line = JSON.stringify(checked.data);
  if (Buffer.byteLength(line) > maxLineBytes) {
    log("ipc.outgoing_too_long", { type: msg.type });
    return null;
  }
  return line + "\n";
}

class ClientConnection implements Connection {
  readonly id: number;
  closed = false;
  private readonly sock: net.Socket;
  private readonly limits: IpcLimits;

  constructor(id: number, sock: net.Socket, limits: IpcLimits) {
    this.id = id;
    this.sock = sock;
    this.limits = limits;
  }

  send(msg: ServerMessage): void {
    const line = serialize(msg, this.limits.maxLineBytes);
    if (line !== null) this.write(line);
  }

  write(line: string): void {
    if (this.closed) return;
    if (this.sock.writableLength > this.limits.maxWriteBuffer) {
      log("ipc.slow_client", { conn: this.id });
      this.destroy();
      return;
    }
    this.sock.write(line);
  }

  /** Envoie une erreur puis ferme la connexion. */
  reject(): void {
    if (this.closed) return;
    this.send({ type: "error", code: "invalid_message", message: "message invalide" });
    this.closed = true;
    this.sock.end();
    // Ne pas attendre indéfiniment un client qui ne lit plus.
    setTimeout(() => this.sock.destroy(), 1000).unref();
  }

  destroy(): void {
    this.closed = true;
    this.sock.destroy();
  }
}

export class IpcServer {
  private readonly path: string;
  private readonly handlers: IpcHandlers;
  private readonly limits: IpcLimits;
  private readonly uid = process.getuid!();
  private readonly connections = new Set<ClientConnection>();
  private server: net.Server | null = null;
  private nextId = 1;

  constructor(path: string, handlers: IpcHandlers, limits: Partial<IpcLimits> = {}) {
    this.path = path;
    this.handlers = handlers;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async start(): Promise<void> {
    await this.prepareSocketPath();
    const server = net.createServer((sock) => this.accept(sock));
    server.maxConnections = this.limits.maxConnections;

    // umask 0177 : la socket est créée directement en 0600, sans fenêtre en 0755.
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.path, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(previousUmask);
    }

    const st = lstatSync(this.path);
    if (!st.isSocket() || st.uid !== this.uid || (st.mode & 0o777) !== 0o600) {
      server.close();
      throw new SocketPathError("la socket n'a pas les droits attendus (0600)");
    }
    server.on("error", (err) => log("ipc.server_error", errorFields(err)));
    this.server = server;
    log("ipc.listening");
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) conn.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      // net.Server.close() supprime lui-même le fichier de la socket.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  broadcast(msg: ServerMessage): void {
    const line = serialize(msg, this.limits.maxLineBytes);
    if (line === null) return;
    for (const conn of this.connections) conn.write(line);
  }

  /**
   * Si le chemin existe déjà : ce doit être une socket de l'utilisateur.
   * Socket morte → supprimée ; socket vivante → refus (un seul daemon).
   */
  private async prepareSocketPath(): Promise<void> {
    let st;
    try {
      st = lstatSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!st.isSocket() || st.uid !== this.uid) {
      throw new SocketPathError("le chemin de la socket existe et n'est pas une socket de l'utilisateur");
    }
    if (await isAlive(this.path)) {
      throw new SocketPathError("un daemon noko tourne déjà");
    }
    unlinkSync(this.path);
    log("ipc.stale_socket_removed");
  }

  private accept(sock: net.Socket): void {
    if (this.connections.size >= this.limits.maxConnections) {
      sock.destroy();
      return;
    }
    const conn = new ClientConnection(this.nextId++, sock, this.limits);
    const decoder = new LineDecoder(this.limits.maxLineBytes);
    this.connections.add(conn);
    log("ipc.connected", { conn: conn.id });

    sock.on("data", (chunk: Buffer) => {
      if (conn.closed) return;
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        log("ipc.rejected", { conn: conn.id, ...errorFields(err) });
        conn.reject();
        return;
      }
      for (const line of lines) {
        if (conn.closed) return;
        this.handleLine(conn, line);
      }
    });
    sock.on("error", (err) => log("ipc.socket_error", { conn: conn.id, ...errorFields(err) }));
    sock.on("close", () => {
      conn.closed = true;
      this.connections.delete(conn);
      log("ipc.disconnected", { conn: conn.id });
    });
  }

  private handleLine(conn: ClientConnection, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      log("ipc.rejected", { conn: conn.id, reason: "json" });
      conn.reject();
      return;
    }
    const parsed = ClientMessage.safeParse(raw);
    if (!parsed.success) {
      log("ipc.rejected", { conn: conn.id, reason: "schema" });
      conn.reject();
      return;
    }
    const msg = parsed.data;
    Promise.resolve()
      .then(() => this.handlers.onMessage(conn, msg))
      .catch((err: unknown) => {
        log("ipc.handler_error", { conn: conn.id, type: msg.type, ...errorFields(err) });
        conn.send({ type: "error", code: "internal", message: "erreur interne" });
      });
  }
}

/** Une socket répond-elle ? ECONNREFUSED = socket morte ; toute autre erreur est remontée. */
function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") resolve(false);
      else reject(err);
    });
  });
}

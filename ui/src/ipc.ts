// Client IPC côté UI : se connecte à la socket du daemon, valide chaque message
// dans les deux sens, et se reconnecte tout seul si le daemon redémarre.

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { LineDecoder } from "../../shared/line-decoder.ts";
import {
  ClientMessage,
  MAX_LINE_BYTES,
  SOCKET_NAME,
  ServerMessage,
} from "../../shared/protocol.ts";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "unavailable";

export interface ClientCallbacks {
  onState(state: ConnectionState): void;
  onMessage(msg: ServerMessage): void;
}

const READ_CHUNK = 64 * 1024;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;

export class DaemonClient {
  private readonly callbacks: ClientCallbacks;
  private readonly encoder = new TextEncoder();
  private path: string | null = null;
  private conn: Gio.SocketConnection | null = null;
  private cancellable: Gio.Cancellable | null = null;
  private queue: Uint8Array[] = [];
  private writing = false;
  private retryDelay = RETRY_MIN_MS;
  private retrySource = 0;
  // Incrémenté à chaque tentative : les rappels d'une connexion abandonnée sont ignorés.
  private generation = 0;

  constructor(callbacks: ClientCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    // Pas de GLib.get_user_runtime_dir() : il se replie sur un autre dossier si la
    // variable manque, alors que le daemon n'écoute que dans $XDG_RUNTIME_DIR.
    const dir = GLib.getenv("XDG_RUNTIME_DIR");
    if (dir === null || !dir.startsWith("/")) {
      this.callbacks.onState("unavailable");
      return;
    }
    this.path = GLib.build_filenamev([dir, SOCKET_NAME]);
    this.connect();
  }

  stop(): void {
    this.generation++;
    if (this.retrySource !== 0) {
      GLib.source_remove(this.retrySource);
      this.retrySource = 0;
    }
    this.closeConnection();
  }

  /** Envoie un message s'il est valide et si la connexion est ouverte. */
  send(msg: ClientMessage): boolean {
    const checked = ClientMessage.safeParse(msg);
    if (!checked.success) {
      console.warn(`noko : message sortant invalide (${msg.type})`);
      return false;
    }
    if (this.conn === null) return false;
    this.queue.push(this.encoder.encode(JSON.stringify(checked.data) + "\n"));
    this.flush();
    return true;
  }

  private connect(): void {
    if (this.path === null) return;
    const gen = ++this.generation;
    const cancellable = new Gio.Cancellable();
    this.cancellable = cancellable;
    this.callbacks.onState("connecting");

    const client = new Gio.SocketClient();
    client.connect_async(Gio.UnixSocketAddress.new(this.path), cancellable, (_src, res) => {
      if (gen !== this.generation) return;
      try {
        this.conn = client.connect_finish(res);
      } catch {
        this.retry();
        return;
      }
      this.retryDelay = RETRY_MIN_MS;
      this.callbacks.onState("connected");
      this.read(gen, this.conn, new LineDecoder(MAX_LINE_BYTES));
      this.send({ type: "state.get" });
    });
  }

  private read(gen: number, conn: Gio.SocketConnection, decoder: LineDecoder): void {
    const input = conn.get_input_stream();
    input.read_bytes_async(READ_CHUNK, GLib.PRIORITY_DEFAULT, this.cancellable, (_src, res) => {
      if (gen !== this.generation) return;
      let data: Uint8Array;
      try {
        data = input.read_bytes_finish(res).toArray();
      } catch {
        this.drop();
        return;
      }
      if (data.length === 0) {
        this.drop(); // fin de flux : le daemon s'est arrêté
        return;
      }
      let lines: string[];
      try {
        lines = decoder.push(data);
      } catch {
        console.warn("noko : ligne invalide reçue du daemon");
        this.drop();
        return;
      }
      for (const line of lines) {
        if (!this.handleLine(line)) {
          this.drop();
          return;
        }
      }
      this.read(gen, conn, decoder);
    });
  }

  /** false si le message est invalide (la connexion doit alors être fermée). */
  private handleLine(line: string): boolean {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      console.warn("noko : JSON invalide reçu du daemon");
      return false;
    }
    const parsed = ServerMessage.safeParse(raw);
    if (!parsed.success) {
      console.warn("noko : message non conforme reçu du daemon");
      return false;
    }
    this.callbacks.onMessage(parsed.data);
    return true;
  }

  private flush(): void {
    const conn = this.conn;
    const next = this.queue[0];
    if (this.writing || conn === null || next === undefined) return;
    this.writing = true;
    const gen = this.generation;
    const output = conn.get_output_stream();
    output.write_all_async(next, GLib.PRIORITY_DEFAULT, this.cancellable, (_src, res) => {
      if (gen !== this.generation) return;
      try {
        output.write_all_finish(res);
      } catch {
        this.drop();
        return;
      }
      this.queue.shift();
      this.writing = false;
      this.flush();
    });
  }

  /** Ferme la connexion courante et planifie une reconnexion. */
  private drop(): void {
    this.generation++;
    this.closeConnection();
    this.retry();
  }

  private closeConnection(): void {
    this.cancellable?.cancel();
    this.cancellable = null;
    try {
      this.conn?.close(null);
    } catch {
      // déjà fermée
    }
    this.conn = null;
    this.queue = [];
    this.writing = false;
  }

  private retry(): void {
    this.callbacks.onState("disconnected");
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.retrySource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this.retrySource = 0;
      this.connect();
      return GLib.SOURCE_REMOVE;
    });
  }
}

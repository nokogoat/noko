// Lecture de la position du curseur via l'IPC de Hyprland (lecture seule).
// Wayland ne donne pas la position absolue du pointeur à une application : sans elle,
// déplacer une surface layer-shell en suivant le curseur saccade.

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { z } from "zod";
import { hyprlandColor } from "../../shared/config.ts";

const MAX_REPLY_BYTES = 64 * 1024;

const CursorPos = z.object({ x: z.number(), y: z.number() });
export type CursorPos = z.infer<typeof CursorPos>;

/** Socket de commande de Hyprland, ou null hors Hyprland. */
function socketPath(): string | null {
  const signature = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE");
  const runtime = GLib.getenv("XDG_RUNTIME_DIR");
  // La signature compose un chemin : refus de tout ce qui n'est pas un identifiant simple.
  if (signature === null || !/^[A-Za-z0-9_]+$/.test(signature)) return null;
  if (runtime === null || !runtime.startsWith("/")) return null;
  return GLib.build_filenamev([runtime, "hypr", signature, ".socket.sock"]);
}

const SOCKET = socketPath();

export function hyprlandAvailable(): boolean {
  return SOCKET !== null;
}

/** Envoie une commande (lecture seule) et renvoie la réponse JSON, ou null. */
function request(command: string, done: (reply: unknown) => void): void {
  if (SOCKET === null) {
    done(null);
    return;
  }
  const client = new Gio.SocketClient();
  client.connect_async(Gio.UnixSocketAddress.new(SOCKET), null, (_src, res) => {
    let conn: Gio.SocketConnection;
    try {
      conn = client.connect_finish(res);
    } catch {
      done(null);
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const finish = (reply: unknown) => {
      try {
        conn.close(null);
      } catch {
        // déjà fermée
      }
      done(reply);
    };
    const read = () => {
      const input = conn.get_input_stream();
      input.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, (_s, r) => {
        let data: Uint8Array;
        try {
          data = input.read_bytes_finish(r).toArray();
        } catch {
          finish(null);
          return;
        }
        if (data.length === 0) {
          const all = new Uint8Array(size);
          let offset = 0;
          for (const c of chunks) {
            all.set(c, offset);
            offset += c.length;
          }
          try {
            finish(JSON.parse(new TextDecoder().decode(all)));
          } catch {
            finish(null);
          }
          return;
        }
        size += data.length;
        if (size > MAX_REPLY_BYTES) {
          finish(null);
          return;
        }
        chunks.push(data);
        read();
      });
    };
    conn.get_output_stream().write_all_async(new TextEncoder().encode(command), GLib.PRIORITY_DEFAULT, null, (_s, r) => {
      try {
        conn.get_output_stream().write_all_finish(r);
      } catch {
        finish(null);
        return;
      }
      read();
    });
  });
}

/** Position du curseur en coordonnées logiques globales, ou null. */
export function cursorPosition(done: (pos: CursorPos | null) => void): void {
  request("j/cursorpos", (reply) => {
    const parsed = CursorPos.safeParse(reply);
    done(parsed.success ? parsed.data : null);
  });
}

const BorderOption = z.object({ gradient: z.string().max(256) });

/** Première couleur de la bordure des fenêtres actives (rgba() CSS), ou null. */
export function activeBorderColor(done: (color: string | null) => void): void {
  request("j/getoption general:col.active_border", (reply) => {
    const parsed = BorderOption.safeParse(reply);
    const first = parsed.success ? parsed.data.gradient.split(/\s+/)[0] : undefined;
    done(first === undefined ? null : hyprlandColor(first));
  });
}

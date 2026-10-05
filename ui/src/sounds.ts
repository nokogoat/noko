// Sons : un chemin de fichier lu par un lecteur fixe (pw-play, sinon paplay).
// La config ne peut contenir aucune commande (SECURITY.md, section External processes).

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { config } from "./settings.ts";

export type SoundEvent = "permission" | "question" | "done";

const EXTENSIONS = new Set(["oga", "ogg", "wav", "flac"]);
const MAX_SOUND_BYTES = 10 * 1024 * 1024;
/** Deux sons trop rapprochés ne se superposent pas. */
const MIN_INTERVAL_MS = 400;

const PLAYER = GLib.find_program_in_path("pw-play") ?? GLib.find_program_in_path("paplay");
let lastPlayed = 0;

/** Fichier son acceptable : chemin absolu, extension connue, fichier régulier pas trop gros. */
function playable(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0")) return false;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!EXTENSIONS.has(extension)) return false;
  try {
    const info = Gio.File.new_for_path(path).query_info(
      "standard::type,standard::size",
      Gio.FileQueryInfoFlags.NONE,
      null,
    );
    return info.get_file_type() === Gio.FileType.REGULAR && info.get_size() <= MAX_SOUND_BYTES;
  } catch {
    return false;
  }
}

export function playSound(event: SoundEvent): void {
  const sounds = config.peek().sounds;
  const path = sounds[event];
  if (!sounds.enabled || path === "" || PLAYER === null) return;
  const now = Date.now();
  if (now - lastPlayed < MIN_INTERVAL_MS || !playable(path)) return;
  lastPlayed = now;
  try {
    // Tableau d'arguments, jamais de shell ; « -- » : le chemin n'est jamais une option.
    Gio.Subprocess.new(
      [PLAYER, "--", path],
      Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
  } catch {
    // Pas de son : rien de grave.
  }
}

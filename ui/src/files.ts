// Lecture et écriture de petits fichiers texte (config, thèmes, état), et dossiers XDG.

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";

/** Au-delà, le fichier est ignoré (une config ou un thème n'a rien à faire si gros). */
const MAX_TEXT_BYTES = 256 * 1024;

/** Dossier XDG : la variable si c'est un chemin absolu, sinon le dossier par défaut. */
function xdgDir(variable: string, fallback: string[]): string {
  const value = GLib.getenv(variable);
  const base = value !== null && value.startsWith("/") ? value : GLib.build_filenamev([GLib.get_home_dir(), ...fallback]);
  return GLib.build_filenamev([base, "noko"]);
}

export const CONFIG_DIR = xdgDir("XDG_CONFIG_HOME", [".config"]);
export const STATE_DIR = xdgDir("XDG_STATE_HOME", [".local", "state"]);

/** Contenu d'un fichier régulier de taille raisonnable, ou null. */
export function readText(path: string): string | null {
  const file = Gio.File.new_for_path(path);
  try {
    const info = file.query_info("standard::type,standard::size", Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_TEXT_BYTES) return null;
    const [, bytes] = file.load_contents(null);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Écrit un fichier de façon atomique (fichier temporaire puis renommage). */
export function writeText(path: string, text: string): boolean {
  try {
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    if (parent !== null && !parent.query_exists(null)) parent.make_directory_with_parents(null);
    file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return true;
  } catch {
    return false;
  }
}

// Affichage des chemins : le dossier personnel est abrégé en `~`.

import GLib from "gi://GLib?version=2.0";

const HOME = GLib.get_home_dir();

export function shortenPath(path: string): string {
  if (path === HOME) return "~";
  if (path.startsWith(HOME + "/")) return "~" + path.slice(HOME.length);
  return path;
}

/** Développe `~` en dossier personnel : le daemon n'accepte que des chemins absolus. */
export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return HOME;
  if (trimmed.startsWith("~/")) return GLib.build_filenamev([HOME, trimmed.slice(2)]);
  return trimmed;
}

export function homeDir(): string {
  return HOME;
}

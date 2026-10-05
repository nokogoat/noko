// Emplacement de la socket : uniquement dans $XDG_RUNTIME_DIR, jamais de repli.

import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SOCKET_NAME } from "../../shared/protocol.ts";

export class RuntimeDirError extends Error {
  override name = "RuntimeDirError";
}

/**
 * Renvoie le chemin de la socket après avoir vérifié que $XDG_RUNTIME_DIR existe,
 * est un vrai dossier (pas un lien), appartient à l'utilisateur et est en 0700.
 */
export function resolveSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  uid: number = process.getuid!(),
): string {
  const dir = env.XDG_RUNTIME_DIR;
  if (dir === undefined || dir === "") {
    throw new RuntimeDirError("XDG_RUNTIME_DIR n'est pas défini");
  }
  if (!isAbsolute(dir)) {
    throw new RuntimeDirError("XDG_RUNTIME_DIR n'est pas un chemin absolu");
  }
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new RuntimeDirError("XDG_RUNTIME_DIR est introuvable");
  }
  if (!st.isDirectory()) {
    throw new RuntimeDirError("XDG_RUNTIME_DIR n'est pas un dossier");
  }
  if (st.uid !== uid) {
    throw new RuntimeDirError("XDG_RUNTIME_DIR n'appartient pas à l'utilisateur");
  }
  if ((st.mode & 0o777) !== 0o700) {
    throw new RuntimeDirError("XDG_RUNTIME_DIR n'est pas en 0700");
  }
  return join(dir, SOCKET_NAME);
}

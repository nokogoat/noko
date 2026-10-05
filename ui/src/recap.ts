// Récapitulatif des fichiers modifiés par tour (d'un message de l'utilisateur au suivant),
// inséré dans la conversation après le tour. Pur TypeScript (sans GJS) : testé avec le daemon.

import type { FileDiff, HistoryMessage } from "../../shared/protocol.ts";

export interface FileChange {
  path: string;
  /** Modifications successives du fichier pendant le tour, dans l'ordre. */
  diffs: FileDiff[];
  added: number;
  removed: number;
}

export type TranscriptItem =
  | { kind: "entry"; entry: HistoryMessage }
  | { kind: "recap"; key: string; files: FileChange[] };

/** Lignes ajoutées et retirées d'une modification. */
export function diffCounts(diff: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/** Fichiers modifiés par une suite de messages, dans l'ordre de leur première modification. */
function filesOf(diffs: readonly FileDiff[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const diff of diffs) {
    let file = byPath.get(diff.path);
    if (file === undefined) {
      file = { path: diff.path, diffs: [], added: 0, removed: 0 };
      byPath.set(diff.path, file);
    }
    const { added, removed } = diffCounts(diff);
    file.diffs.push(diff);
    file.added += added;
    file.removed += removed;
  }
  return [...byPath.values()];
}

/**
 * Messages de la conversation, avec après chaque tour le récap de ses fichiers modifiés.
 * Le dernier tour n'en a un que s'il est terminé (`working` faux). La clé d'un récap
 * (début du tour, nombre de modifications) ne change que si son contenu change.
 */
export function withRecaps(entries: readonly HistoryMessage[], working: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let turnStart = 0;
  let diffs: FileDiff[] = [];
  const closeTurn = () => {
    if (diffs.length > 0) items.push({ kind: "recap", key: `${turnStart}:${diffs.length}`, files: filesOf(diffs) });
    diffs = [];
  };
  entries.forEach((entry, i) => {
    if (entry.role === "user" && i > 0) {
      closeTurn();
      turnStart = i;
    }
    items.push({ kind: "entry", entry });
    if (entry.diff !== undefined) diffs.push(entry.diff);
  });
  if (!working) closeTurn();
  return items;
}

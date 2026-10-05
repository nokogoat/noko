// Diff ligne à ligne, sans dépendance : préfixe et suffixe communs retirés, puis plus
// longue sous-suite commune sur le reste. Trop coûteux → tout retiré puis tout ajouté
// (moins lisible, mais toujours exact).

import type { DiffHunk } from "../../shared/protocol.ts";

export type DiffOp = { kind: " " | "+" | "-"; text: string };

/** Taille maximale de la table de la plus longue sous-suite commune (cellules). */
const MAX_LCS_CELLS = 4_000_000;

/** Lignes d'un texte ; le saut de ligne final ne crée pas de ligne vide. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: " ", text: a[i]! });
  ops.push(...middle(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i++) ops.push({ kind: " ", text: a[i]! });
  return ops;
}

function middle(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  }
  // lcs[i][j] : longueur de la plus longue sous-suite commune de a[i..] et b[j..].
  // Elle ne dépasse pas min(n, m) ≤ 2000 (n × m ≤ MAX_LCS_CELLS) : 16 bits suffisent.
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: "-", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "-", text: a[i]! });
  for (; j < m; j++) ops.push({ kind: "+", text: b[j]! });
  return ops;
}

/**
 * Regroupe les opérations en blocs, avec `context` lignes inchangées autour de chaque
 * changement (Infinity : tout garder). Numéros de ligne à partir de `oldStart` et
 * `newStart`, ou null s'ils sont inconnus.
 */
export function toHunks(
  ops: readonly DiffOp[],
  context: number,
  oldStart: number | null = 1,
  newStart: number | null = 1,
): DiffHunk[] {
  // Garder une ligne inchangée si un changement est à `context` lignes ou moins.
  const keep = ops.map((op) => op.kind !== " ");
  if (context === Infinity) {
    keep.fill(ops.some((op) => op.kind !== " "));
  } else {
    let last = -Infinity;
    for (let i = 0; i < ops.length; i++) {
      if (ops[i]!.kind !== " ") last = i;
      else if (i - last <= context) keep[i] = true;
    }
    last = Infinity;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i]!.kind !== " ") last = i;
      else if (last - i <= context) keep[i] = true;
    }
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (keep[i]) {
      if (current === null) {
        current = {
          oldStart: oldStart === null ? null : oldStart + oldLine,
          newStart: newStart === null ? null : newStart + newLine,
          lines: [],
        };
        hunks.push(current);
      }
      current.lines.push(op.kind + op.text);
    } else {
      current = null;
    }
    if (op.kind !== "+") oldLine++;
    if (op.kind !== "-") newLine++;
  }
  return hunks;
}

/** Coupe les blocs au-delà de `maxLines` lignes ou `maxBytes` octets une fois en JSON (échappements compris). */
export function limitHunks(
  hunks: readonly DiffHunk[],
  maxLines: number,
  maxBytes: number,
): { hunks: DiffHunk[]; truncated: boolean } {
  const kept: DiffHunk[] = [];
  let lines = 0;
  let bytes = 0;
  for (const hunk of hunks) {
    const taken: string[] = [];
    for (const line of hunk.lines) {
      bytes += Buffer.byteLength(JSON.stringify(line)) + 1;
      if (lines >= maxLines || bytes > maxBytes) {
        if (taken.length > 0) kept.push({ ...hunk, lines: taken });
        return { hunks: kept, truncated: true };
      }
      taken.push(line);
      lines++;
    }
    kept.push({ ...hunk, lines: taken });
  }
  return { hunks: kept, truncated: false };
}

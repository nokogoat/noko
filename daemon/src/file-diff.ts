// Avant/après des outils qui modifient un fichier (Edit, Write).
// Dans la conversation : d'après l'entrée seule. Pour une demande d'autorisation : d'après
// le fichier actuel, lu avec des bornes strictes. Ce n'est qu'un complément : l'UI garde
// l'entrée exacte de l'outil à portée (SECURITY.md, section Permissions).

import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { z } from "zod";
import { AbsolutePath, MAX_DIFF_LINES, type FileDiff } from "../../shared/protocol.ts";
import { diffLines, limitHunks, splitLines, toHunks, type DiffOp } from "./diff.ts";

/** Taille maximale d'un fichier lu pour un aperçu. */
export const MAX_PREVIEW_FILE_BYTES = 1024 * 1024;
/** Lignes inchangées montrées autour d'un changement. */
const CONTEXT_LINES = 3;

/**
 * Limites d'un diff de demande d'autorisation. Avec l'entrée (768 Kio au plus), une demande
 * reste sous 1 Mio : l'instantané de l'état, qui les contient toutes, tient sur une ligne IPC.
 */
const PERMISSION_LIMITS = { lines: MAX_DIFF_LINES, bytes: 256 * 1024 };
/** Limites d'un diff dans la conversation (plusieurs par historique). */
const CONVERSATION_LIMITS = { lines: 400, bytes: 64 * 1024 };

const EditInput = z.object({ file_path: AbsolutePath, old_string: z.string(), new_string: z.string() });
const WriteInput = z.object({ file_path: AbsolutePath, content: z.string() });

/** Contenu texte d'un fichier ; "missing" s'il n'existe pas ; null s'il est illisible. */
export type ReadText = (path: string) => Promise<string | "missing" | null>;

function build(
  path: string,
  kind: FileDiff["kind"],
  ops: DiffOp[],
  context: number,
  oldStart: number | null,
  newStart: number | null,
  limits: { lines: number; bytes: number },
): FileDiff {
  const { hunks, truncated } = limitHunks(toHunks(ops, context, oldStart, newStart), limits.lines, limits.bytes);
  return { path, kind, hunks, truncated };
}

const added = (text: string): DiffOp[] => splitLines(text).map((line) => ({ kind: "+", text: line }));

/** Diff d'un appel d'outil pour la conversation, d'après son entrée seule. */
export function conversationDiff(toolName: string, input: unknown): FileDiff | undefined {
  if (toolName === "Edit") {
    const edit = EditInput.safeParse(input);
    if (!edit.success) return undefined;
    const { file_path, old_string, new_string } = edit.data;
    const ops = diffLines(splitLines(old_string), splitLines(new_string));
    return build(file_path, "edit", ops, Infinity, null, null, CONVERSATION_LIMITS);
  }
  if (toolName === "Write") {
    const write = WriteInput.safeParse(input);
    if (!write.success) return undefined;
    return build(write.data.file_path, "write", added(write.data.content), Infinity, null, 1, CONVERSATION_LIMITS);
  }
  return undefined;
}

/** Diff d'une demande d'autorisation, d'après le fichier actuel. null : outil non concerné. */
export async function permissionDiff(toolName: string, input: unknown, read: ReadText = readText): Promise<FileDiff | null> {
  const limits = PERMISSION_LIMITS;
  if (toolName === "Edit") {
    const edit = EditInput.safeParse(input);
    if (!edit.success) return null;
    const { file_path, old_string, new_string } = edit.data;
    const current = await read(file_path);
    if (old_string === "" && current === "missing") {
      return build(file_path, "create", added(new_string), Infinity, null, 1, limits);
    }
    const index = typeof current === "string" && old_string !== "" ? current.indexOf(old_string) : -1;
    if (typeof current !== "string" || index === -1) {
      // Passage introuvable (ou fichier illisible) : le passage seul, sans numéros de ligne.
      const ops = diffLines(splitLines(old_string), splitLines(new_string));
      return build(file_path, "edit", ops, Infinity, null, null, limits);
    }
    return editInFile(file_path, current, index, old_string, new_string, limits);
  }
  if (toolName === "Write") {
    const write = WriteInput.safeParse(input);
    if (!write.success) return null;
    const { file_path, content } = write.data;
    const current = await read(file_path);
    if (current === "missing") return build(file_path, "create", added(content), Infinity, null, 1, limits);
    if (current === null) return build(file_path, "write", added(content), Infinity, null, 1, limits);
    const ops = diffLines(splitLines(current), splitLines(content));
    return build(file_path, "overwrite", ops, CONTEXT_LINES, 1, 1, limits);
  }
  return null;
}

/**
 * Remplacement de la première occurrence, en lignes entières (comme dans le fichier après
 * modification), avec quelques lignes autour.
 */
function editInFile(
  path: string,
  file: string,
  index: number,
  oldString: string,
  newString: string,
  limits: { lines: number; bytes: number },
): FileDiff {
  const lineStart = file.lastIndexOf("\n", index - 1) + 1;
  const newline = file.indexOf("\n", index + oldString.length - 1);
  const lineEnd = newline === -1 ? file.length : newline + 1;
  const before = file.slice(lineStart, lineEnd);
  const offset = index - lineStart;
  const after = before.slice(0, offset) + newString + before.slice(offset + oldString.length);

  const firstLine = splitLines(file.slice(0, lineStart)).length + 1;
  const above = splitLines(file.slice(0, lineStart)).slice(-CONTEXT_LINES);
  const below = splitLines(file.slice(lineEnd)).slice(0, CONTEXT_LINES);
  const ops: DiffOp[] = [
    ...above.map((text) => ({ kind: " " as const, text })),
    ...diffLines(splitLines(before), splitLines(after)),
    ...below.map((text) => ({ kind: " " as const, text })),
  ];
  const start = firstLine - above.length;
  return build(path, "edit", ops, Infinity, start, start, limits);
}

/**
 * Lit un fichier texte pour un aperçu : fichier régulier uniquement (jamais une FIFO ou
 * un périphérique, qui pourraient bloquer ou réagir à l'ouverture), taille bornée, UTF-8
 * valide. Le contenu ne sert qu'à l'aperçu et n'est jamais journalisé.
 */
export const readText: ReadText = async (path) => {
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch {
    return null;
  }
  try {
    // Revérifié sur le descripteur ouvert : le chemin a pu changer entre-temps.
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PREVIEW_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_PREVIEW_FILE_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

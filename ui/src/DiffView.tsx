// Avant/après d'une modification de fichier, calculé par le daemon. Texte brut uniquement.
// Les lignes consécutives de même nature forment un seul libellé (peu de widgets, même
// pour un gros diff).

import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import type { DiffHunk, FileDiff } from "../../shared/protocol.ts";
import { shortenPath } from "./paths.ts";

const KIND_LABEL: Record<FileDiff["kind"], string> = {
  edit: "Modification",
  create: "Nouveau fichier",
  overwrite: "Fichier réécrit",
  write: "Contenu écrit",
};

const LINE_CLASS: Record<string, string> = { "+": "diff-add", "-": "diff-del", " ": "diff-ctx" };

/** « +3 −1 » : lignes ajoutées et retirées. */
export function diffStats(diff: FileDiff): string {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return `+${added} −${removed}${diff.truncated ? " (incomplet)" : ""}`;
}

/** Lignes consécutives de même nature (« + », « - » ou « »). */
function runs(lines: readonly string[]): { kind: string; text: string }[] {
  const result: { kind: string; text: string }[] = [];
  for (const line of lines) {
    const kind = line[0] ?? " ";
    const last = result[result.length - 1];
    if (last !== undefined && last.kind === kind) last.text += "\n" + line;
    else result.push({ kind, text: line });
  }
  return result;
}

function Hunk({ hunk, first }: { hunk: DiffHunk; first: boolean }) {
  const start = hunk.newStart ?? hunk.oldStart;
  const header = start !== null ? `ligne ${start}` : first ? null : "…";
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
      {header !== null ? <Gtk.Label class="diff-hunk" label={header} useMarkup={false} xalign={0} /> : null}
      {runs(hunk.lines).map((run) => (
        <Gtk.Label
          class={`diff-line ${LINE_CLASS[run.kind] ?? "diff-ctx"}`}
          label={run.text}
          useMarkup={false}
          wrap
          wrapMode={Pango.WrapMode.CHAR}
          xalign={0}
        />
      ))}
    </Gtk.Box>
  );
}

/** Diff complet ; `header` : titre (nature, chemin, statistiques) au-dessus. */
export function DiffView({ diff, header = true }: { diff: FileDiff; header?: boolean }) {
  return (
    <Gtk.Box class="diff" orientation={Gtk.Orientation.VERTICAL} spacing={2}>
      {header ? (
        <Gtk.Label
          class="diff-title"
          label={`${KIND_LABEL[diff.kind]} · ${shortenPath(diff.path)} · ${diffStats(diff)}`}
          useMarkup={false}
          ellipsize={Pango.EllipsizeMode.START}
          xalign={0}
        />
      ) : null}
      {diff.hunks.length === 0 ? <Gtk.Label class="diff-hunk" label="Aucun changement" xalign={0} /> : null}
      {diff.hunks.map((hunk, i) => (
        <Hunk hunk={hunk} first={i === 0} />
      ))}
      {diff.truncated ? (
        <Gtk.Label
          class="permission-warning"
          label="Diff trop long, coupé : seule l'entrée exacte fait foi."
          wrap
          xalign={0}
        />
      ) : null}
    </Gtk.Box>
  );
}

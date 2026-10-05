// Mise en page d'une réponse de Claude (Markdown analysé par markdown.ts). Le texte reste
// du texte brut : gras, italique, code… sont des attributs Pango posés sur des plages, jamais
// du balisage interprété (use_markup reste faux). Les couleurs viennent du thème.

import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { type Block, type Inline, parseMarkdown } from "./markdown.ts";
import { claimKeyboardOnClick } from "./keyboard.ts";
import { activeTheme } from "./settings.ts";

/** Couleur du thème (#rgb, #rrggbb[aa], rgb[a]()) → composantes 16 bits pour Pango. */
function pangoColor(color: string): [number, number, number] | null {
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  } else {
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
    if (m !== null) rgb = [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)));
  }
  if (rgb === null || rgb.some((v) => Number.isNaN(v))) return null;
  return rgb.map((v) => v * 257) as [number, number, number];
}

/** Texte brut et attributs d'une suite de segments (indices Pango en octets UTF-8). */
function styled(runs: readonly Inline[]): { text: string; attrs: Pango.AttrList } {
  const encoder = new TextEncoder();
  const attrs = new Pango.AttrList();
  const { theme, accent } = activeTheme.peek();
  // Le gras reste plus gras que le texte, même avec une graisse de base élevée.
  const strong = Math.min(900, Math.max(700, theme.font.weight + 300)) as Pango.Weight;
  const codeColor = pangoColor(accent ?? theme.colors.accent);
  let text = "";
  let offset = 0;
  const add = (attr: Pango.Attribute, start: number, end: number) => {
    attr.start_index = start;
    attr.end_index = end;
    attrs.insert(attr);
  };
  for (const run of runs) {
    const start = offset;
    const end = offset + encoder.encode(run.text).length;
    if (run.bold) add(Pango.attr_weight_new(strong), start, end);
    if (run.italic) add(Pango.attr_style_new(Pango.Style.ITALIC), start, end);
    if (run.strike) add(Pango.attr_strikethrough_new(true), start, end);
    if (run.link) add(Pango.attr_underline_new(Pango.Underline.SINGLE), start, end);
    if (run.code) {
      add(Pango.attr_family_new("monospace"), start, end);
      if (codeColor !== null) add(Pango.attr_foreground_new(...codeColor), start, end);
    }
    text += run.text;
    offset = end;
  }
  return { text, attrs };
}

/** Libellé sélectionnable (clic : clavier pris pour Ctrl+C ; clic droit : Copier). */
function richLabel(runs: readonly Inline[], cls: string): Gtk.Label {
  const { text, attrs } = styled(runs);
  const label = new Gtk.Label({
    label: text,
    attributes: attrs,
    useMarkup: false,
    selectable: true,
    wrap: true,
    wrapMode: Pango.WrapMode.WORD_CHAR,
    xalign: 0,
    hexpand: true,
    cssClasses: [cls],
  });
  claimKeyboardOnClick(label);
  return label;
}

function tableView(header: Inline[][], rows: Inline[][][]): Gtk.Widget {
  const grid = new Gtk.Grid({ columnSpacing: 14, rowSpacing: 4, cssClasses: ["md-table"] });
  header.forEach((cell, col) => grid.attach(richLabel(cell, "md-th"), col, 0, 1, 1));
  rows.forEach((row, r) => row.forEach((cell, col) => grid.attach(richLabel(cell, "md-td"), col, r + 1, 1, 1)));
  return grid;
}

function blockView(block: Block): Gtk.Widget {
  switch (block.kind) {
    case "paragraph":
      return richLabel(block.runs, "md-p");
    case "heading":
      return richLabel(block.runs, `md-h${block.level}`);
    case "quote":
      return richLabel(block.runs, "md-quote");
    case "rule":
      return new Gtk.Separator({ cssClasses: ["md-rule"] });
    case "table":
      return tableView(block.header, block.rows);
    case "list": {
      const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, cssClasses: ["md-list"] });
      for (const item of block.items) {
        const row = new Gtk.Box({ spacing: 6, marginStart: item.depth * 16 });
        row.append(new Gtk.Label({ label: item.marker, valign: Gtk.Align.START, cssClasses: ["md-marker"] }));
        row.append(richLabel(item.runs, "md-li"));
        list.append(row);
      }
      return list;
    }
    case "code": {
      const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, cssClasses: ["md-code"] });
      if (block.lang !== "") box.append(new Gtk.Label({ label: block.lang, xalign: 0, cssClasses: ["md-code-lang"] }));
      const code = new Gtk.Label({
        label: block.text,
        useMarkup: false,
        selectable: true,
        wrap: true,
        wrapMode: Pango.WrapMode.CHAR,
        xalign: 0,
        cssClasses: ["md-code-text"],
      });
      claimKeyboardOnClick(code);
      box.append(code);
      return box;
    }
  }
}

/** Réponse mise en page : un widget par bloc. */
export function markdownView(text: string): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, cssClasses: ["markdown"] });
  for (const block of parseMarkdown(text)) box.append(blockView(block));
  return box;
}

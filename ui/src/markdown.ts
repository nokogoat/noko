// Analyse du Markdown des réponses de Claude, pour la mise en page. Aucun balisage n'est
// produit : le résultat est du texte brut découpé en blocs et en segments stylés, que l'UI
// affiche avec des attributs (jamais de balisage Pango sur du texte non fiable).
// Sous-ensemble utile : titres, paragraphes, listes, code, citations, tableaux, séparateurs ;
// en ligne : gras, italique, barré, code, liens (seul le texte du lien est gardé).
// Pur TypeScript (sans GJS) : testé avec le daemon.

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

export interface ListItem {
  /** « • », « ◦ » ou « 3. ». */
  marker: string;
  /** Niveau d'imbrication (0 à 3). */
  depth: number;
  runs: Inline[];
}

export type Block =
  | { kind: "paragraph"; runs: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; runs: Inline[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; runs: Inline[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>]/;
const LINK = /^\[([^\]\n]+)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/;

/** Découpe une ligne de tableau en cellules (sans les « | » de bord). */
function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      current += "|";
      i++;
    } else if (row[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += row[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

const isTableStart = (lines: readonly string[], i: number) =>
  (lines[i] ?? "").includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-");

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", runs: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      // Bloc non fermé (réponse en cours) : il va jusqu'à la fin.
      while (i < lines.length && !(lines[i]!.trim().startsWith(marker) && lines[i]!.trim().replace(/[`~]/g, "") === "")) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, runs: parseInline(heading[2]!) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      flush();
      const header = tableCells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(tableCells(lines[i]!).map(parseInline));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1]!);
        i++;
      }
      blocks.push({ kind: "quote", runs: parseInline(body.join("\n")) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const items: { marker: string; depth: number; text: string }[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const item = LIST_ITEM.exec(current);
        if (item !== null) {
          const depth = Math.min(Math.floor(item[1]!.replace(/\t/g, "    ").length / 2), 3);
          const bullet = /^\d/.test(item[2]!) ? item[2]!.replace(")", ".") : depth === 0 ? "•" : "◦";
          items.push({ marker: bullet, depth, text: item[3]! });
          i++;
        } else if (current.trim() !== "" && /^\s+/.test(current) && items.length > 0) {
          // Suite indentée de l'élément précédent.
          items[items.length - 1]!.text += "\n" + current.trim();
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", items: items.map((it) => ({ marker: it.marker, depth: it.depth, runs: parseInline(it.text) })) });
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Segments stylés d'un texte en ligne. Un marqueur sans fermeture reste du texte. */
export function parseInline(text: string): Inline[] {
  const runs: Inline[] = [];
  const style = { bold: false, italic: false, strike: false };
  let buffer = "";

  const push = (value: string, extra: Partial<Inline> = {}) => {
    if (value === "") return;
    const run: Inline = { text: value };
    if (style.bold) run.bold = true;
    if (style.italic) run.italic = true;
    if (style.strike) run.strike = true;
    Object.assign(run, extra);
    const last = runs[runs.length - 1];
    const same =
      last !== undefined &&
      !last.code &&
      !last.link &&
      !run.code &&
      !run.link &&
      !!last.bold === !!run.bold &&
      !!last.italic === !!run.italic &&
      !!last.strike === !!run.strike;
    if (same) last.text += run.text;
    else runs.push(run);
  };
  const flush = () => {
    push(buffer);
    buffer = "";
  };

  /** Le marqueur à `i` ouvre (fermeture plus loin) ou ferme (style actif) un style. */
  const toggles = (i: number, marker: string, active: boolean, wordSensitive: boolean): boolean => {
    const before = text[i - 1];
    const after = text[i + marker.length];
    if (active) return !isSpace(before) && !(wordSensitive && isWord(after));
    if (isSpace(after) || (wordSensitive && isWord(before))) return false;
    const close = text.indexOf(marker, i + marker.length + 1);
    return close !== -1 && !isSpace(text[close - 1]);
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;

    if (c === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks++;
      const fence = "`".repeat(ticks);
      const end = text.indexOf(fence, i + ticks);
      if (end !== -1) {
        flush();
        let code = text.slice(i + ticks, end);
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
        push(code, { code: true });
        i = end + ticks;
        continue;
      }
      buffer += fence;
      i += ticks;
      continue;
    }

    if (c === "[") {
      const link = LINK.exec(text.slice(i));
      if (link !== null) {
        flush();
        push(link[1]!, { link: true });
        i += link[0].length;
        continue;
      }
    }

    const double = text.slice(i, i + 2);
    if ((double === "**" || double === "__") && toggles(i, double, style.bold, double === "__")) {
      flush();
      style.bold = !style.bold;
      i += 2;
      continue;
    }
    if (double === "~~" && toggles(i, double, style.strike, false)) {
      flush();
      style.strike = !style.strike;
      i += 2;
      continue;
    }
    if ((c === "*" || c === "_") && toggles(i, c, style.italic, c === "_")) {
      flush();
      style.italic = !style.italic;
      i += 1;
      continue;
    }

    buffer += c;
    i++;
  }
  flush();
  return runs;
}

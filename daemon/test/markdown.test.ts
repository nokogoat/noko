import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown } from "../../ui/src/markdown.ts";

test("en ligne : gras, italique, code, barré, lien", () => {
  assert.deepEqual(parseInline("un **gras** et *italique*"), [
    { text: "un " },
    { text: "gras", bold: true },
    { text: " et " },
    { text: "italique", italic: true },
  ]);
  assert.deepEqual(parseInline("lance `npm run dev` ici"), [
    { text: "lance " },
    { text: "npm run dev", code: true },
    { text: " ici" },
  ]);
  assert.deepEqual(parseInline("~~non~~ [doc](https://exemple.org)"), [
    { text: "non", strike: true },
    { text: " " },
    { text: "doc", link: true },
  ]);
  assert.deepEqual(parseInline("**`code` en gras**"), [
    { text: "code", bold: true, code: true },
    { text: " en gras", bold: true },
  ]);
});

test("en ligne : un marqueur sans fermeture ou isolé reste du texte", () => {
  assert.deepEqual(parseInline("2 * 3 = 6"), [{ text: "2 * 3 = 6" }]);
  assert.deepEqual(parseInline("**pas fermé"), [{ text: "**pas fermé" }]);
  assert.deepEqual(parseInline("snake_case_name"), [{ text: "snake_case_name" }]);
  assert.deepEqual(parseInline("`pas fermé"), [{ text: "`pas fermé" }]);
  assert.deepEqual(parseInline("\\*littéral\\*"), [{ text: "*littéral*" }]);
});

test("blocs : titres, paragraphes, listes, séparateur", () => {
  const blocks = parseMarkdown("# Titre\n\nUn paragraphe\nsur deux lignes.\n\n- un\n- deux\n  - sous\n1. premier\n\n---");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 1, runs: [{ text: "Titre" }] },
    { kind: "paragraph", runs: [{ text: "Un paragraphe\nsur deux lignes." }] },
    {
      kind: "list",
      items: [
        { marker: "•", depth: 0, runs: [{ text: "un" }] },
        { marker: "•", depth: 0, runs: [{ text: "deux" }] },
        { marker: "◦", depth: 1, runs: [{ text: "sous" }] },
        { marker: "1.", depth: 0, runs: [{ text: "premier" }] },
      ],
    },
    { kind: "rule" },
  ]);
});

test("blocs : code (fermé ou en cours), citation, tableau", () => {
  assert.deepEqual(parseMarkdown("```sh\nls -la\n# pas un titre\n```\nfin"), [
    { kind: "code", lang: "sh", text: "ls -la\n# pas un titre" },
    { kind: "paragraph", runs: [{ text: "fin" }] },
  ]);
  // Réponse en cours de streaming : le bloc non fermé va jusqu'au bout.
  assert.deepEqual(parseMarkdown("```\nen cours"), [{ kind: "code", lang: "", text: "en cours" }]);
  assert.deepEqual(parseMarkdown("> cité\n> suite"), [{ kind: "quote", runs: [{ text: "cité\nsuite" }] }]);
  assert.deepEqual(parseMarkdown("| A | B |\n|---|:-:|\n| 1 | `x` |"), [
    {
      kind: "table",
      header: [[{ text: "A" }], [{ text: "B" }]],
      rows: [[[{ text: "1" }], [{ text: "x", code: true }]]],
    },
  ]);
});

test("titres au-delà du niveau 3 ramenés à 3, texte vide sans bloc", () => {
  assert.deepEqual(parseMarkdown("##### petit"), [{ kind: "heading", level: 3, runs: [{ text: "petit" }] }]);
  assert.deepEqual(parseMarkdown("\n\n"), []);
});

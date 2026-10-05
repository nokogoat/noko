import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileDiff, HistoryMessage } from "../../shared/protocol.ts";
import { diffCounts, withRecaps } from "../../ui/src/recap.ts";

const diff = (path: string, lines: string[]): FileDiff => ({
  path,
  kind: "edit",
  hunks: [{ oldStart: 1, newStart: 1, lines }],
  truncated: false,
});

const user = (text: string): HistoryMessage => ({ role: "user", text });
const reply = (text: string): HistoryMessage => ({ role: "assistant", text });
const edit = (d: FileDiff): HistoryMessage => ({ role: "tool", text: `Edit : ${d.path}`, diff: d });

test("compte les lignes ajoutées et retirées", () => {
  assert.deepEqual(diffCounts(diff("/p/a.ts", ["+x", "+y", "-z", " ctx"])), { added: 2, removed: 1 });
});

test("un récap après chaque tour qui modifie des fichiers, fichiers regroupés", () => {
  const a1 = diff("/p/a.ts", ["+x"]);
  const b = diff("/p/b.ts", ["-y"]);
  const a2 = diff("/p/a.ts", ["+z", "-w"]);
  const entries = [user("1"), edit(a1), edit(b), edit(a2), reply("fait"), user("2"), reply("rien à modifier")];
  const items = withRecaps(entries, false);
  assert.deepEqual(
    items.map((it) => (it.kind === "entry" ? it.entry.role : `recap ${it.key}`)),
    ["user", "tool", "tool", "tool", "assistant", "recap 0:3", "user", "assistant"],
  );
  const recap = items[5];
  assert.ok(recap?.kind === "recap");
  assert.deepEqual(
    recap.files.map((f) => [f.path, f.added, f.removed, f.diffs.length]),
    [
      ["/p/a.ts", 2, 1, 2],
      ["/p/b.ts", 0, 1, 1],
    ],
  );
});

test("le tour en cours n'a son récap qu'une fois terminé", () => {
  const entries = [user("1"), edit(diff("/p/a.ts", ["+x"]))];
  assert.equal(withRecaps(entries, true).filter((it) => it.kind === "recap").length, 0);
  assert.equal(withRecaps(entries, false).filter((it) => it.kind === "recap").length, 1);
});

test("historique qui commence sans message de l'utilisateur", () => {
  const items = withRecaps([edit(diff("/p/a.ts", ["+x"])), user("2")], true);
  assert.deepEqual(
    items.map((it) => it.kind),
    ["entry", "recap", "entry"],
  );
});

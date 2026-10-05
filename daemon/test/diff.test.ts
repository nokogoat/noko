import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileDiff, type DiffHunk } from "../../shared/protocol.ts";
import { diffLines, limitHunks, splitLines, toHunks, type DiffOp } from "../src/diff.ts";
import { conversationDiff, MAX_PREVIEW_FILE_BYTES, permissionDiff, readText, type ReadText } from "../src/file-diff.ts";
import { assistantEntries } from "../src/history.ts";

/** Les deux côtés d'un diff : lignes inchangées + retirées, et inchangées + ajoutées. */
function sides(ops: readonly DiffOp[]): [string[], string[]] {
  return [ops.filter((o) => o.kind !== "+").map((o) => o.text), ops.filter((o) => o.kind !== "-").map((o) => o.text)];
}

/** Générateur pseudo-aléatoire reproductible. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

test("découpe en lignes sans ligne vide finale", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a"), ["a"]);
  assert.deepEqual(splitLines("a\n"), ["a"]);
  assert.deepEqual(splitLines("a\n\nb\n\n"), ["a", "", "b", ""]);
});

test("un diff reconstruit toujours les deux textes, sans changement superflu", () => {
  const random = rng(42);
  const words = ["a", "b", "c", "d", ""];
  for (let round = 0; round < 300; round++) {
    const make = () => Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * words.length)]!);
    const a = make();
    const b = make();
    const ops = diffLines(a, b);
    assert.deepEqual(sides(ops), [a, b]);
    // Diff minimal : autant de lignes inchangées que la plus longue sous-suite commune.
    assert.equal(ops.filter((o) => o.kind === " ").length, lcsLength(a, b));
  }
});

function lcsLength(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    }
  }
  return t[0]![0]!;
}

test("trop gros pour la plus longue sous-suite commune : tout retiré puis tout ajouté, exact", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  const ops = diffLines(["début", ...a, "fin"], ["début", ...b, "fin"]);
  assert.deepEqual(sides(ops), [["début", ...a, "fin"], ["début", ...b, "fin"]]);
  assert.equal(ops[1]!.kind, "-");
  assert.equal(ops[ops.length - 2]!.kind, "+");
});

test("blocs : contexte autour des changements et numéros de ligne", () => {
  const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  const b = ["1", "deux", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
  const hunks = toHunks(diffLines(a, b), 1);
  assert.deepEqual(hunks, [
    { oldStart: 1, newStart: 1, lines: [" 1", "-2", "+deux", " 3"] },
    { oldStart: 10, newStart: 10, lines: [" 10", "+11"] },
  ]);
  // Contexte infini : un seul bloc ; aucun changement : aucun bloc.
  assert.equal(toHunks(diffLines(a, b), Infinity).length, 1);
  assert.deepEqual(toHunks(diffLines(a, a), Infinity), []);
  assert.deepEqual(toHunks(diffLines(["x"], ["y"]), Infinity, null, null), [
    { oldStart: null, newStart: null, lines: ["-x", "+y"] },
  ]);
});

test("blocs coupés au-delà des limites", () => {
  const hunks: DiffHunk[] = [
    { oldStart: 1, newStart: 1, lines: ["+a", "+b"] },
    { oldStart: 9, newStart: 10, lines: ["+c", "+d"] },
  ];
  assert.deepEqual(limitHunks(hunks, 10, 1000), { hunks, truncated: false });
  assert.deepEqual(limitHunks(hunks, 3, 1000), {
    hunks: [hunks[0], { oldStart: 9, newStart: 10, lines: ["+c"] }],
    truncated: true,
  });
  // Chaque ligne compte pour sa taille en JSON (« "+a" », 4 octets) plus le saut de ligne.
  assert.deepEqual(limitHunks(hunks, 10, 9), { hunks: [{ oldStart: 1, newStart: 1, lines: ["+a"] }], truncated: true });
});

const files = (content: Record<string, string | null>): ReadText => async (path) =>
  path in content ? content[path]! : "missing";

test("autorisation Edit : lignes entières du fichier, numéros et contexte", async () => {
  const file = "un\ndeux\ntrois\nquatre cinq\nsix\nsept\nhuit\nneuf\n";
  const diff = await permissionDiff(
    "Edit",
    { file_path: "/p/f.txt", old_string: "cinq\nsix", new_string: "5\n6\n6 bis" },
    files({ "/p/f.txt": file }),
  );
  assert.deepEqual(diff, {
    path: "/p/f.txt",
    kind: "edit",
    truncated: false,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [" un", " deux", " trois", "-quatre cinq", "-six", "+quatre 5", "+6", "+6 bis", " sept", " huit", " neuf"],
      },
    ],
  });
  assert.equal(FileDiff.safeParse(diff).success, true);
});

test("autorisation Edit : passage introuvable, fichier illisible, création", async () => {
  const input = { file_path: "/p/f.txt", old_string: "a\nb", new_string: "a\nc" };
  const fragment = { path: "/p/f.txt", kind: "edit", truncated: false, hunks: [{ oldStart: null, newStart: null, lines: [" a", "-b", "+c"] }] };
  assert.deepEqual(await permissionDiff("Edit", input, files({ "/p/f.txt": "autre chose" })), fragment);
  assert.deepEqual(await permissionDiff("Edit", input, files({ "/p/f.txt": null })), fragment);
  assert.deepEqual(
    await permissionDiff("Edit", { file_path: "/p/n.txt", old_string: "", new_string: "x\ny\n" }, files({})),
    { path: "/p/n.txt", kind: "create", truncated: false, hunks: [{ oldStart: null, newStart: 1, lines: ["+x", "+y"] }] },
  );
});

test("autorisation Write : création, réécriture, contenu précédent inconnu", async () => {
  const read = files({ "/p/old.txt": "a\nb\nc\n", "/p/bin": null });
  assert.equal((await permissionDiff("Write", { file_path: "/p/new.txt", content: "x" }, read))?.kind, "create");
  assert.deepEqual(await permissionDiff("Write", { file_path: "/p/old.txt", content: "a\nB\nc\n" }, read), {
    path: "/p/old.txt",
    kind: "overwrite",
    truncated: false,
    hunks: [{ oldStart: 1, newStart: 1, lines: [" a", "-b", "+B", " c"] }],
  });
  assert.deepEqual(await permissionDiff("Write", { file_path: "/p/bin", content: "x\n" }, read), {
    path: "/p/bin",
    kind: "write",
    truncated: false,
    hunks: [{ oldStart: null, newStart: 1, lines: ["+x"] }],
  });
});

test("autorisation : autres outils et entrées inattendues → pas de diff", async () => {
  const read = files({});
  assert.equal(await permissionDiff("Bash", { command: "ls" }, read), null);
  assert.equal(await permissionDiff("Edit", { file_path: "relatif", old_string: "a", new_string: "b" }, read), null);
  assert.equal(await permissionDiff("Write", { file_path: "/p/x" }, read), null);
});

test("conversation : diff d'après l'entrée seule, borné", () => {
  assert.deepEqual(conversationDiff("Edit", { file_path: "/p/f", old_string: "a", new_string: "b" }), {
    path: "/p/f",
    kind: "edit",
    truncated: false,
    hunks: [{ oldStart: null, newStart: null, lines: ["-a", "+b"] }],
  });
  const big = conversationDiff("Write", { file_path: "/p/f", content: "x\n".repeat(1000) });
  assert.equal(big?.kind, "write");
  assert.equal(big?.truncated, true);
  assert.equal(big?.hunks[0]?.lines.length, 400);
  assert.equal(conversationDiff("Bash", { command: "ls" }), undefined);

  // L'historique porte le diff avec le résumé de l'appel.
  const [entry] = assistantEntries({
    content: [{ type: "tool_use", id: "1", name: "Edit", input: { file_path: "/p/f", old_string: "a", new_string: "b" } }],
  });
  assert.equal(entry?.role, "tool");
  assert.equal(entry?.diff?.kind, "edit");
});

test("lecture des fichiers : fichier régulier, taille et UTF-8 bornés", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noko-diff-"));
  try {
    writeFileSync(join(dir, "ok.txt"), "é\n");
    writeFileSync(join(dir, "big.txt"), "x".repeat(MAX_PREVIEW_FILE_BYTES + 1));
    writeFileSync(join(dir, "bin"), Buffer.from([0xff, 0xfe, 0x00]));
    symlinkSync(join(dir, "ok.txt"), join(dir, "lien"));
    execFileSync("mkfifo", [join(dir, "fifo")]);

    assert.equal(await readText(join(dir, "ok.txt")), "é\n");
    assert.equal(await readText(join(dir, "lien")), "é\n");
    assert.equal(await readText(join(dir, "absent")), "missing");
    assert.equal(await readText(join(dir, "big.txt")), null);
    assert.equal(await readText(join(dir, "bin")), null);
    assert.equal(await readText(join(dir, "fifo")), null);
    assert.equal(await readText(dir), null);
    assert.equal(await readText("/dev/zero"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

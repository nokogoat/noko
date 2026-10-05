import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantEntries } from "../src/history.ts";
import { toolSummary } from "../src/tool-summary.ts";

test("résume un appel d'outil par son argument principal", () => {
  assert.equal(toolSummary("Bash", { command: "ls -la", description: "Lister" }), "Bash : ls -la");
  assert.equal(toolSummary("Write", { file_path: "/srv/a.txt", content: "x" }), "Write : /srv/a.txt");
  assert.equal(toolSummary("Bash", { command: "echo a\necho b" }), "Bash : echo a …");
  assert.equal(toolSummary("Bash", { command: "x".repeat(300) }), `Bash : ${"x".repeat(160)}…`);
  assert.equal(toolSummary("TodoWrite", { todos: [] }), "TodoWrite");
  assert.equal(toolSummary("Bash", null), "Bash");
});

test("un message de Claude donne texte et outils dans l'ordre", () => {
  assert.deepEqual(
    assistantEntries({
      content: [
        { type: "text", text: "Je regarde." },
        { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "Voilà." },
      ],
    }),
    [
      { role: "assistant", text: "Je regarde." },
      { role: "tool", text: "Bash : ls" },
      { role: "assistant", text: "Voilà." },
    ],
  );
  assert.deepEqual(assistantEntries({ content: "court" }), [{ role: "assistant", text: "court" }]);
  assert.deepEqual(assistantEntries(42), []);
});

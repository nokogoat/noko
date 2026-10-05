import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_MAX_BYTES, HISTORY_MAX_MESSAGES, messageText, trimHistory } from "../src/history.ts";
import type { HistoryMessage } from "../../shared/protocol.ts";

test("extrait uniquement le texte d'un message", () => {
  assert.equal(messageText({ role: "user", content: "salut" }), "salut");
  assert.equal(
    messageText({
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", id: "t", name: "Bash", input: {} },
        { type: "text", text: "b" },
      ],
    }),
    "ab",
  );
  assert.equal(messageText({ content: [{ type: "tool_result", content: "sortie" }] }), "");
  assert.equal(messageText(null), "");
  assert.equal(messageText({ content: 42 }), "");
});

test("garde les messages les plus récents dans les limites", () => {
  const many: HistoryMessage[] = Array.from({ length: HISTORY_MAX_MESSAGES + 10 }, (_, i) => ({
    role: "user",
    text: String(i),
  }));
  const kept = trimHistory(many);
  assert.equal(kept.length, HISTORY_MAX_MESSAGES);
  assert.equal(kept.at(-1)?.text, String(HISTORY_MAX_MESSAGES + 9));

  const big = "x".repeat(HISTORY_MAX_BYTES / 2);
  const sized = trimHistory([
    { role: "user", text: big },
    { role: "assistant", text: big },
    { role: "user", text: "dernier" },
  ]);
  assert.deepEqual(
    sized.map((m) => m.text.length),
    [big.length, "dernier".length],
  );
});

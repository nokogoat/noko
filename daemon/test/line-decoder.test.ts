import assert from "node:assert/strict";
import { test } from "node:test";
import { LineDecoder, LineTooLongError } from "../src/line-decoder.ts";

const b = (s: string) => Buffer.from(s, "utf8");

test("découpe plusieurs lignes et recolle les fragments", () => {
  const d = new LineDecoder(100);
  assert.deepEqual(d.push(b("a\nbb\ncc")), ["a", "bb"]);
  assert.deepEqual(d.push(b("c")), []);
  assert.deepEqual(d.push(b("\n")), ["ccc"]);
});

test("recolle un caractère UTF-8 coupé entre deux fragments", () => {
  const d = new LineDecoder(100);
  const e = b("é\n");
  assert.deepEqual(d.push(e.subarray(0, 1)), []);
  assert.deepEqual(d.push(e.subarray(1)), ["é"]);
});

test("rejette une ligne trop longue avant sa fin", () => {
  const d = new LineDecoder(4);
  assert.deepEqual(d.push(b("abcd\n")), ["abcd"]);
  assert.throws(() => d.push(b("abcde")), LineTooLongError);
  const d2 = new LineDecoder(4);
  d2.push(b("abc"));
  assert.throws(() => d2.push(b("de\n")), LineTooLongError);
});

test("rejette l'UTF-8 invalide", () => {
  const d = new LineDecoder(100);
  assert.throws(() => d.push(Buffer.from([0xff, 0x0a])), TypeError);
});

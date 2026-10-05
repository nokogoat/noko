import assert from "node:assert/strict";
import { test } from "node:test";
import { findWindowPid, isAlive, isPid, ownedByUser, parentPid } from "../src/terminal.ts";

test("pid : entier strictement supérieur à 1", () => {
  assert.equal(isPid(1234), true);
  for (const bad of [0, 1, -5, 1.5, NaN, Infinity]) assert.equal(isPid(bad), false);
});

test("processus courant : vivant, à l'utilisateur, parent lu dans /proc", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(ownedByUser(process.pid), true);
  assert.equal(parentPid(process.pid), process.ppid);
  assert.equal(parentPid(4_194_303), null);
});

test("remonte l'arbre jusqu'à la fenêtre, sans boucler", () => {
  const parents = new Map([
    [300, 200], // claude → shell
    [200, 100], // shell → terminal
    [100, 2],
  ]);
  const parentOf = (pid: number) => parents.get(pid) ?? null;
  assert.equal(findWindowPid(300, new Set([100]), parentOf), 100);
  assert.equal(findWindowPid(300, new Set([300]), parentOf), 300);
  assert.equal(findWindowPid(300, new Set([999]), parentOf), null);
  // Cycle : abandon après une profondeur maximale.
  assert.equal(findWindowPid(10, new Set([999]), (pid) => (pid === 10 ? 11 : 10)), null);
});

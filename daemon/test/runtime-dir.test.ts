import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { resolveSocketPath, RuntimeDirError } from "../src/runtime-dir.ts";

const root = mkdtempSync(join(tmpdir(), "noko-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const uid = process.getuid!();

test("renvoie le chemin de la socket pour un dossier valide", () => {
  chmodSync(root, 0o700);
  assert.equal(resolveSocketPath({ XDG_RUNTIME_DIR: root }, uid), join(root, "noko.sock"));
});

test("refuse une variable absente, vide ou relative", () => {
  assert.throws(() => resolveSocketPath({}, uid), RuntimeDirError);
  assert.throws(() => resolveSocketPath({ XDG_RUNTIME_DIR: "" }, uid), RuntimeDirError);
  assert.throws(() => resolveSocketPath({ XDG_RUNTIME_DIR: "run" }, uid), RuntimeDirError);
});

test("refuse un dossier introuvable, un lien ou de mauvais droits", () => {
  assert.throws(() => resolveSocketPath({ XDG_RUNTIME_DIR: join(root, "absent") }, uid), RuntimeDirError);
  const link = join(root, "lien");
  symlinkSync(root, link);
  assert.throws(() => resolveSocketPath({ XDG_RUNTIME_DIR: link }, uid), RuntimeDirError);
  chmodSync(root, 0o755);
  assert.throws(() => resolveSocketPath({ XDG_RUNTIME_DIR: root }, uid), RuntimeDirError);
  chmodSync(root, 0o700);
});

test("refuse un dossier d'un autre utilisateur", () => {
  assert.throws(() => resolveSocketPath({ XDG_RUNTIME_DIR: root }, uid + 1), RuntimeDirError);
});

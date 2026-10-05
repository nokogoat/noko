import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { dataDir, SessionStore } from "../src/session-store.ts";

const root = mkdtempSync(join(tmpdir(), "noko-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("dossier de données : XDG_DATA_HOME absolu, sinon ~/.local/share", () => {
  assert.equal(dataDir({ XDG_DATA_HOME: "/srv/data" }), "/srv/data/noko");
  assert.ok(dataDir({ XDG_DATA_HOME: "relatif" }).endsWith("/.local/share/noko"));
  assert.ok(dataDir({}).endsWith("/.local/share/noko"));
});

test("enregistre, relit et protège la base", () => {
  const dir = join(root, "data");
  const store = new SessionStore(dir);
  const info = {
    id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    claudeSessionId: "c1",
    name: "projet",
    source: "noko" as const,
    cwd: "/srv/projet",
    status: "running" as const,
    lastActivity: 1000,
    activity: null,
    usage: null,
  };
  store.save(info);
  store.save({ ...info, name: "renommé", lastActivity: 2000 });
  assert.deepEqual(store.load(), [{ ...info, name: "renommé", lastActivity: 2000, status: "stopped" }]);
  store.delete(info.id);
  store.delete(info.id); // déjà supprimée : sans effet
  assert.deepEqual(store.load(), []);
  store.close();

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "sessions.db")).mode & 0o777, 0o600);
});

test("ignore les lignes invalides", () => {
  const dir = join(root, "invalide");
  new SessionStore(dir).close();
  const db = new DatabaseSync(join(dir, "sessions.db"));
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, 'noko')").run("pas-un-uuid", null, "x", "/srv", 1);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, 'noko')").run(
    "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    null,
    "x",
    "relatif",
    1,
  );
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, 'inconnue')").run(
    "7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    null,
    "x",
    "/srv",
    1,
  );
  db.close();
  const store = new SessionStore(dir);
  assert.deepEqual(store.load(), []);
  store.close();
});

test("ajoute la colonne source à une base existante", () => {
  const dir = join(root, "ancienne");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "sessions.db"));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, claude_session_id TEXT, name TEXT NOT NULL, cwd TEXT NOT NULL,
    last_activity INTEGER NOT NULL
  ) STRICT`);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", "c1", "x", "/srv", 1);
  db.close();
  const store = new SessionStore(dir);
  assert.equal(store.load()[0]?.source, "noko");
  store.close();
});

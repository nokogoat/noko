import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isTrustedFolder, settingSourcesFor } from "../src/trust.ts";

const root = mkdtempSync(join(tmpdir(), "noko-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const trusted = join(root, "fiable");
const untrusted = join(root, "inconnu");
mkdirSync(trusted);
mkdirSync(untrusted);
const config = join(root, ".claude.json");

function writeConfig(projects: unknown): void {
  writeFileSync(config, JSON.stringify({ autre: 1, projects }));
}

test("lit les réglages du projet seulement pour un dossier accepté", async () => {
  writeConfig({ [trusted]: { hasTrustDialogAccepted: true }, [untrusted]: { hasTrustDialogAccepted: false } });
  assert.deepEqual(await settingSourcesFor(trusted, config), ["user", "project", "local"]);
  assert.deepEqual(await settingSourcesFor(untrusted, config), ["user"]);
});

test("compare le chemin réel, sans hériter du dossier parent", async () => {
  writeConfig({ [trusted]: { hasTrustDialogAccepted: true } });
  const link = join(root, "lien");
  symlinkSync(trusted, link);
  assert.equal(await isTrustedFolder(link, config), true);
  const child = join(trusted, "sous-dossier");
  mkdirSync(child);
  assert.equal(await isTrustedFolder(child, config), false);
});

test("échoue fermé : config absente, illisible ou inattendue", async () => {
  assert.equal(await isTrustedFolder(trusted, join(root, "absent.json")), false);
  writeFileSync(config, "{ pas du json");
  assert.equal(await isTrustedFolder(trusted, config), false);
  writeConfig({ [trusted]: { hasTrustDialogAccepted: "oui" } });
  assert.equal(await isTrustedFolder(trusted, config), false);
  writeConfig({ [trusted]: { hasTrustDialogAccepted: true } });
  assert.equal(await isTrustedFolder(join(root, "absent"), config), false);
});

test("ignore les clés héritées du prototype", async () => {
  writeConfig({});
  assert.equal(await isTrustedFolder("/", config), false);
  writeFileSync(config, '{"projects":{"__proto__":{"hasTrustDialogAccepted":true}}}');
  assert.equal(await isTrustedFolder(root, config), false);
});

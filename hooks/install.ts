// Installe (ou retire, avec --uninstall) les hooks de noko dans ~/.claude/settings.json.
//
// Règles (CLAUDE.md, section Sécurité) : chemin absolu vers le script ; script et dossiers
// appartenant à l'utilisateur et modifiables par lui seul ; sauvegarde de settings.json en
// 0600, hors du repo ; fusion sans écraser les hooks existants ; diff affiché avant
// d'écrire. Le contenu de settings.json n'est jamais affiché, seules les lignes modifiées.

import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { addNokoHooks, changedLines, removeNokoHooks, type Settings } from "./settings-merge.ts";

const uid = process.getuid!();

function fail(message: string): never {
  process.stderr.write(`noko : ${message}\n`);
  process.exit(1);
}

function settingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return join(dir !== undefined && isAbsolute(dir) ? dir : join(homedir(), ".claude"), "settings.json");
}

function backupDir(): string {
  const base = process.env.XDG_STATE_HOME;
  return join(base !== undefined && isAbsolute(base) ? base : join(homedir(), ".local", "state"), "noko", "backups");
}

/**
 * Personne d'autre que l'utilisateur (ou root) ne peut modifier ce chemin : propriétaire,
 * pas d'écriture pour le groupe ni les autres. Root est accepté pour les dossiers parents et
 * l'exécutable node, et partout pour une installation par paquet (/usr/lib/noko).
 */
function checkWritableOnlyByUser(path: string, allowRoot: boolean): void {
  const st = statSync(path);
  const owner = st.uid === uid || (allowRoot && st.uid === 0);
  if (!owner || (st.mode & 0o022) !== 0) {
    fail(`${path} doit appartenir à l'utilisateur et n'être modifiable que par lui`);
  }
}

/** Le script, ses dépendances et tous les dossiers qui les contiennent. */
function checkScript(repo: string, script: string, node: string): void {
  const files = [
    script,
    join(repo, "hooks", "hook-message.ts"),
    join(repo, "shared", "protocol.ts"),
    join(repo, "shared", "line-decoder.ts"),
    join(repo, "daemon", "src", "runtime-dir.ts"),
    join(repo, "package.json"),
  ];
  // Paquet système : tout appartient à root (personne d'autre ne peut le modifier).
  const system = statSync(repo).uid === 0;
  for (const file of files) checkWritableOnlyByUser(file, system);
  for (const dir of ["hooks", "shared", "daemon", join("daemon", "src"), "node_modules", join("node_modules", "zod")]) {
    checkWritableOnlyByUser(join(repo, dir), system);
  }
  // Dossiers parents du repo : l'utilisateur ou root.
  for (let dir = repo; ; dir = dirname(dir)) {
    checkWritableOnlyByUser(dir, true);
    if (dirname(dir) === dir) break;
  }
  checkWritableOnlyByUser(node, true);
}

function readSettings(path: string): { settings: Settings; existed: boolean; mode: number } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, existed: false, mode: 0o600 };
    fail(`lecture de ${path} impossible`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${path} n'est pas du JSON valide : rien n'a été modifié`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${path} n'est pas un objet JSON : rien n'a été modifié`);
  }
  return { settings: parsed as Settings, existed: true, mode: statSync(path).mode & 0o777 };
}

/** Copie de settings.json en 0600 dans ~/.local/state/noko/backups (hors du repo). */
function backup(path: string): string {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = join(dir, `settings-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  copyFileSync(path, target);
  chmodSync(target, 0o600);
  return target;
}

/** Écriture atomique ; un lien symbolique (dotfiles) est suivi, pas remplacé. */
function writeSettings(path: string, settings: Settings, mode: number): void {
  let target = path;
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
  } catch {
    // fichier absent : créé
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.noko-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^(o|oui|y|yes)$/i.test(answer.trim());
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const uninstall = args.has("--uninstall");
  const yes = args.has("--yes");

  const repo = realpathSync(join(import.meta.dirname, ".."));
  const script = join(repo, "hooks", "noko-hook.ts");
  const node = realpathSync(process.execPath);
  if (!uninstall) checkScript(repo, script, node);

  const path = settingsPath();
  const { settings, existed, mode } = readSettings(path);
  let next: Settings;
  try {
    next = uninstall ? removeNokoHooks(settings) : addNokoHooks(settings, node, script);
  } catch (err) {
    fail(`${err instanceof Error ? err.message : "structure inattendue"} : rien n'a été modifié`);
  }

  // Comparaison sur le JSON réindenté : seules les entrées de noko apparaissent.
  const diff = changedLines(JSON.stringify(settings, null, 2), JSON.stringify(next, null, 2));
  if (diff.length === 0) {
    process.stdout.write(`Rien à changer dans ${path}.\n`);
    return;
  }
  process.stdout.write(`Modifications de ${path} :\n\n${diff.join("\n")}\n\n`);
  if (!yes && !(await confirm("Appliquer ? [o/N] "))) {
    process.stdout.write("Rien n'a été modifié.\n");
    return;
  }
  if (existed) process.stdout.write(`Sauvegarde : ${backup(path)}\n`);
  // Fichier créé par l'installeur : 0600 ; sinon ses droits sont conservés.
  writeSettings(path, next, mode);
  process.stdout.write(uninstall ? "Hooks de noko retirés.\n" : "Hooks de noko installés.\n");
}

main().catch(() => fail("installation interrompue"));

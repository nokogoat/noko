// Processus des sessions lancées dans un terminal : vivacité, propriétaire, et focus de
// la fenêtre du terminal dans Hyprland. Le pid de `claude` n'est pas celui de la fenêtre :
// on remonte l'arbre des processus jusqu'à un pid connu de Hyprland.

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

/** Au-delà, on arrête de remonter (boucle ou arbre anormalement profond). */
const MAX_DEPTH = 64;
const HYPRCTL_TIMEOUT_MS = 2000;
const HYPRCTL_MAX_BUFFER = 4 * 1024 * 1024;

export interface TerminalDeps {
  /** Le processus existe encore. */
  isAlive(pid: number): boolean;
  /** Le processus appartient à l'utilisateur du daemon. */
  ownedByUser(pid: number): boolean;
  /** Met au premier plan la fenêtre du terminal de ce processus ; false si introuvable. */
  focus(pid: number): Promise<boolean>;
}

export function isPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 1;
}

export function isAlive(pid: number): boolean {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM : le processus existe, mais appartient à un autre utilisateur.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function ownedByUser(pid: number, uid: number = process.getuid!()): boolean {
  if (!isPid(pid)) return false;
  try {
    return statSync(`/proc/${pid}`).uid === uid;
  } catch {
    return false;
  }
}

/** Parent d'un processus, lu dans /proc/<pid>/stat ; null si illisible. */
export function parentPid(pid: number): number | null {
  if (!isPid(pid)) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // « pid (comm) state ppid … » : comm peut contenir espaces et parenthèses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  return isPid(ppid) ? ppid : null;
}

/** Premier ancêtre (le processus compris) qui possède une fenêtre ; null sinon. */
export function findWindowPid(
  pid: number,
  windowPids: ReadonlySet<number>,
  parentOf: (pid: number) => number | null = parentPid,
): number | null {
  let current: number | null = pid;
  for (let depth = 0; current !== null && depth < MAX_DEPTH; depth++) {
    if (windowPids.has(current)) return current;
    current = parentOf(current);
  }
  return null;
}

const Clients = z.array(z.object({ pid: z.number().int() })).max(10_000);

async function hyprctl(args: string[]): Promise<string> {
  // Tableau d'arguments, jamais de shell (SECURITY.md, section External processes).
  const { stdout } = await run("hyprctl", args, {
    timeout: HYPRCTL_TIMEOUT_MS,
    maxBuffer: HYPRCTL_MAX_BUFFER,
    encoding: "utf8",
  });
  return stdout;
}

async function windowPids(): Promise<Set<number>> {
  const parsed = Clients.safeParse(JSON.parse(await hyprctl(["-j", "clients"])));
  return new Set(parsed.success ? parsed.data.map((c) => c.pid).filter(isPid) : []);
}

export async function focusTerminal(pid: number): Promise<boolean> {
  try {
    const target = findWindowPid(pid, await windowPids());
    if (target === null || !isPid(target)) return false;
    await hyprctl(["dispatch", "focuswindow", `pid:${target}`]);
    return true;
  } catch {
    // Hyprland absent, hyprctl introuvable ou réponse illisible.
    return false;
  }
}

export const terminalDeps: TerminalDeps = { isAlive, ownedByUser: (pid) => ownedByUser(pid), focus: focusTerminal };

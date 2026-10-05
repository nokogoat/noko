// Ajout et retrait des hooks de noko dans ~/.claude/settings.json (fonctions pures,
// testées dans daemon/test/install.test.ts). Les hooks existants ne sont jamais modifiés :
// seules les entrées de noko (reconnues à leur script) sont ajoutées ou retirées.

import { TERMINAL_PERMISSION_TIMEOUT_MS } from "../shared/protocol.ts";

export class SettingsShapeError extends Error {
  override name = "SettingsShapeError";
}

/** Nom du script de hook : reconnaît les entrées de noko, même après un déplacement du repo. */
export const HOOK_SCRIPT_NAME = "noko-hook.ts";

/** Délai (secondes) des événements simples : le hook rend la main en 2 s au plus. */
const EVENT_TIMEOUT_S = 5;
/** Demande d'autorisation : attente du daemon, plus une marge. */
const PERMISSION_TIMEOUT_S = TERMINAL_PERMISSION_TIMEOUT_MS / 1000 + 15;

interface HookSpec {
  event: string;
  matcher?: string;
  timeout: number;
  statusMessage?: string;
}

export const HOOK_SPECS: readonly HookSpec[] = [
  { event: "SessionStart", timeout: EVENT_TIMEOUT_S },
  { event: "UserPromptSubmit", timeout: EVENT_TIMEOUT_S },
  { event: "Stop", timeout: EVENT_TIMEOUT_S },
  { event: "StopFailure", timeout: EVENT_TIMEOUT_S },
  { event: "Notification", matcher: "idle_prompt", timeout: EVENT_TIMEOUT_S },
  { event: "SessionEnd", timeout: EVENT_TIMEOUT_S },
  {
    event: "PermissionRequest",
    timeout: PERMISSION_TIMEOUT_S,
    statusMessage: `Réponse attendue dans noko (${TERMINAL_PERMISSION_TIMEOUT_MS / 1000} s au plus)…`,
  },
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Settings = { [key: string]: Json };

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Entrée (handler) ajoutée par noko : commande en forme « exec » vers son script. */
function isNokoHandler(handler: Json): boolean {
  if (!isObject(handler) || handler.type !== "command") return false;
  const args = handler.args;
  return Array.isArray(args) && typeof args[0] === "string" && args[0].endsWith(`/${HOOK_SCRIPT_NAME}`);
}

/** Copie profonde : les fonctions ci-dessous ne modifient jamais leur entrée. */
function clone(settings: Settings): Settings {
  return structuredClone(settings);
}

/** Tableau des groupes d'un événement, ou erreur si la structure est inattendue. */
function groupsOf(hooks: { [key: string]: Json }, event: string): Json[] {
  const groups = hooks[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new SettingsShapeError(`hooks.${event} n'est pas un tableau`);
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      throw new SettingsShapeError(`hooks.${event} contient un groupe inattendu`);
    }
  }
  return groups;
}

/** Retire les entrées de noko ; les groupes et événements vidés par ce retrait disparaissent. */
export function removeNokoHooks(settings: Settings): Settings {
  const next = clone(settings);
  if (next.hooks === undefined) return next;
  if (!isObject(next.hooks)) throw new SettingsShapeError("hooks n'est pas un objet");
  const hooks = next.hooks;
  for (const event of Object.keys(hooks)) {
    const groups = groupsOf(hooks, event);
    const kept: Json[] = [];
    let changed = false;
    for (const group of groups) {
      const handlers = (group as { hooks: Json[] }).hooks;
      const others = handlers.filter((h) => !isNokoHandler(h));
      if (others.length === handlers.length) {
        kept.push(group);
        continue;
      }
      changed = true;
      if (others.length > 0) kept.push({ ...(group as object), hooks: others });
    }
    if (!changed) continue;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** Ajoute (ou remplace) les entrées de noko, pour ce node et ce script (chemins absolus). */
export function addNokoHooks(settings: Settings, node: string, script: string): Settings {
  if (!node.startsWith("/") || !script.startsWith("/")) throw new Error("chemins absolus attendus");
  const next = removeNokoHooks(settings);
  if (next.hooks === undefined) next.hooks = {};
  if (!isObject(next.hooks)) throw new SettingsShapeError("hooks n'est pas un objet");
  const hooks = next.hooks;
  for (const spec of HOOK_SPECS) {
    const handler: { [key: string]: Json } = {
      type: "command",
      // Forme « exec » : pas de shell, le chemin n'est jamais interprété.
      command: node,
      args: [script],
      timeout: spec.timeout,
    };
    if (spec.statusMessage !== undefined) handler.statusMessage = spec.statusMessage;
    const group: { [key: string]: Json } = spec.matcher !== undefined ? { matcher: spec.matcher } : {};
    group.hooks = [handler];
    hooks[spec.event] = [...groupsOf(hooks, spec.event), group];
  }
  return next;
}

/**
 * Lignes ajoutées (+) et retirées (-) entre deux textes, sans contexte : le reste du
 * fichier (qui peut contenir des clés dans `env`) n'est jamais affiché.
 */
export function changedLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Plus longue sous-suite commune, par programmation dynamique (fichiers courts).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push(`+ ${b[j++]}`);
    } else {
      out.push(`- ${a[i++]}`);
    }
  }
  return out;
}

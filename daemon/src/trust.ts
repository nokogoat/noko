// Quels réglages Claude Code une session lancée par noko peut-elle lire ?
// Comme le terminal : les réglages de l'utilisateur toujours ; ceux du projet
// (CLAUDE.md, .claude/settings.json…) seulement si l'utilisateur a déjà fait confiance
// à ce dossier dans Claude Code. Au moindre doute, le dossier est considéré non fiable.

import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Seul le champ utile est lu ; le reste de ~/.claude.json est ignoré.
const ClaudeConfig = z.object({
  projects: z.record(z.string(), z.object({ hasTrustDialogAccepted: z.boolean().optional() })),
});

/** Emplacement de la config globale de Claude Code (~/.claude.json, ou $CLAUDE_CONFIG_DIR). */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir !== undefined && isAbsolute(dir)) return join(dir, ".claude.json");
  return join(homedir(), ".claude.json");
}

/** Vrai seulement si ce dossier exact (chemin réel) a été accepté dans Claude Code. */
export async function isTrustedFolder(cwd: string, configPath: string = claudeConfigPath()): Promise<boolean> {
  try {
    const [real, raw] = await Promise.all([realpath(cwd), readFile(configPath, "utf8")]);
    const parsed = ClaudeConfig.safeParse(JSON.parse(raw));
    if (!parsed.success) return false;
    // Recherche par clé propre : pas d'accès par la chaîne de prototypes.
    const entry = Object.hasOwn(parsed.data.projects, real) ? parsed.data.projects[real] : undefined;
    return entry?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

export async function settingSourcesFor(cwd: string, configPath?: string): Promise<SettingSource[]> {
  return (await isTrustedFolder(cwd, configPath)) ? ["user", "project", "local"] : ["user"];
}

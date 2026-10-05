// Historique d'une session, lu dans les transcripts de Claude Code via le SDK.
// Seul le texte est gardé (ni outils, ni résultats d'outils, ni sous-agents).

import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { HistoryMessage } from "../../shared/protocol.ts";
import { toolSummary } from "./tool-summary.ts";

export type LoadHistory = (claudeSessionId: string, cwd: string) => Promise<HistoryMessage[]>;

/** Nombre maximal de messages renvoyés (les plus récents). */
export const HISTORY_MAX_MESSAGES = 200;
/** Budget en octets de JSON, pour rester sous la taille maximale d'une ligne IPC (1 Mio). */
export const HISTORY_MAX_BYTES = 768 * 1024;

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
const ToolUseBlock = z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() });
const Content = z.union([z.string(), z.array(z.unknown())]);
const ApiMessage = z.object({ content: Content });

/** Extrait le texte d'un message de l'API ; chaîne vide s'il n'en contient pas. */
export function messageText(message: unknown): string {
  const parsed = ApiMessage.safeParse(message);
  if (!parsed.success) return "";
  const content = parsed.data.content;
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    const text = TextBlock.safeParse(block);
    if (text.success) parts.push(text.data.text);
  }
  return parts.join("");
}

/**
 * Entrées de conversation d'un message de Claude, dans l'ordre : texte, puis un résumé
 * par appel d'outil.
 */
export function assistantEntries(message: unknown): HistoryMessage[] {
  const parsed = ApiMessage.safeParse(message);
  if (!parsed.success) return [];
  const content = parsed.data.content;
  if (typeof content === "string") return content === "" ? [] : [{ role: "assistant", text: content }];
  const entries: HistoryMessage[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") entries.push({ role: "assistant", text });
    text = "";
  };
  for (const block of content) {
    const t = TextBlock.safeParse(block);
    if (t.success) {
      text += t.data.text;
      continue;
    }
    const tool = ToolUseBlock.safeParse(block);
    if (tool.success) {
      flush();
      entries.push({ role: "tool", text: toolSummary(tool.data.name, tool.data.input) });
    }
  }
  flush();
  return entries;
}

/** Garde les messages les plus récents dans les limites de nombre et de taille. */
export function trimHistory(messages: HistoryMessage[]): HistoryMessage[] {
  const kept: HistoryMessage[] = [];
  let budget = HISTORY_MAX_BYTES;
  for (let i = messages.length - 1; i >= 0 && kept.length < HISTORY_MAX_MESSAGES; i--) {
    const msg = messages[i]!;
    // Taille une fois sérialisé (échappements compris), plus une marge pour l'enveloppe.
    const size = Buffer.byteLength(JSON.stringify(msg.text)) + 32;
    if (size > budget) break;
    budget -= size;
    kept.push(msg);
  }
  return kept.reverse();
}

export const loadHistory: LoadHistory = async (claudeSessionId, cwd) => {
  const raw = await getSessionMessages(claudeSessionId, { dir: cwd });
  const messages: HistoryMessage[] = [];
  for (const msg of raw) {
    if (msg.parent_tool_use_id !== null) continue;
    if (msg.type === "assistant") {
      messages.push(...assistantEntries(msg.message));
    } else if (msg.type === "user") {
      const text = messageText(msg.message);
      if (text !== "") messages.push({ role: "user", text });
    }
  }
  return trimHistory(messages);
};

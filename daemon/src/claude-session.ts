// Une session Claude Code pilotée par le SDK Agent, en mode « streaming input » :
// la session reste ouverte et reçoit les messages suivants au fil de l'eau.

import {
  query,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  MANAGED_ENV,
  type FileDiff,
  type ImageAttachment,
  type Question,
  type QuestionAnswers,
  type SessionActivity,
  type SessionUsage,
} from "../../shared/protocol.ts";
import { assistantEntries } from "./history.ts";
import type { Decision, PermissionAsk } from "./permissions.ts";
import { parseQuestions } from "./questions.ts";
import { settingSourcesFor } from "./trust.ts";

export interface SessionEvents {
  /** Identifiant de session Claude Code, reçu à l'initialisation. */
  onInit(claudeSessionId: string): void;
  onDelta(text: string): void;
  onAssistantText(text: string): void;
  onTurnEnd(isError: boolean): void;
  /** Fin de la session ; `error` est défini si elle s'est terminée sur une erreur. */
  onExit(error?: unknown): void;
  /** Ce que fait Claude en ce moment ; null une fois le tour terminé. */
  onActivity(activity: SessionActivity | null): void;
  /** Appel d'outil, résumé pour la conversation. */
  onToolUse(summary: string, diff?: FileDiff): void;
  onUsage(usage: SessionUsage): void;
  /** Questions à choix (AskUserQuestion) : réponses de l'utilisateur, ou null. */
  askQuestions(questions: Question[], signal: AbortSignal): Promise<QuestionAnswers | null>;
  /** Demande d'autorisation d'un outil : la décision vient de l'utilisateur, dans l'UI. */
  requestPermission(ask: PermissionAsk, signal: AbortSignal): Promise<Decision>;
}

/** Message de l'utilisateur : texte et images jointes. */
export interface UserMessage {
  text: string;
  images: readonly ImageAttachment[];
}

export interface RunningSession {
  send(message: UserMessage): void;
  stop(): void;
}

export interface StartOptions {
  cwd: string;
  prompt: UserMessage;
  /** Identifiant de session Claude Code à reprendre. */
  resume?: string;
  events: SessionEvents;
}

/** Point d'injection : le daemon ne dépend que de cette signature (remplacée dans les tests). */
export type StartSession = (opts: StartOptions) => RunningSession;

/** File asynchrone qui alimente le SDK en messages utilisateur. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push({ text, images }: UserMessage): void {
    if (this.closed) return;
    // Images d'abord, puis le texte (ordre recommandé par l'API).
    const content: SDKUserMessage["message"]["content"] =
      images.length === 0
        ? text
        : [
            ...images.map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
            })),
            { type: "text" as const, text },
          ];
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.items.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

const DENIED_BY_USER = "Refusé par l'utilisateur dans noko.";

/**
 * Relaye chaque demande d'autorisation vers l'UI. Toute erreur donne un refus.
 * Jamais d'`updatedInput` ni de règle « toujours autoriser » : seule cette exécution
 * précise, avec cette entrée exacte, est autorisée.
 */
export function permissionHandler(events: SessionEvents): CanUseTool {
  return async (toolName, input, options) => {
    // Questions à choix : les réponses de l'utilisateur sont ajoutées dans `answers`, seul
    // champ modifié de l'entrée (seule exception, voir SECURITY.md).
    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      if (questions !== null) {
        try {
          const answers = await events.askQuestions(questions, options.signal);
          if (answers !== null) return { behavior: "allow", updatedInput: { ...input, answers } };
        } catch {
          // refus ci-dessous
        }
      }
      return { behavior: "deny", message: "L'utilisateur n'a pas répondu aux questions dans noko." };
    }
    try {
      const decision = await events.requestPermission(
        {
          toolName,
          input,
          title: options.title ?? null,
          reason: options.decisionReason ?? null,
          blockedPath: options.blockedPath ?? null,
        },
        options.signal,
      );
      if (decision === "allow") return { behavior: "allow" };
    } catch {
      // refus ci-dessous
    }
    return { behavior: "deny", message: DENIED_BY_USER };
  };
}

const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

/** Tokens présents dans le contexte lors d'un appel au modèle. */
function contextSize(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export const startClaudeSession: StartSession = ({ cwd, prompt, resume, events }) => {
  const input = new InputQueue();
  const abortController = new AbortController();
  input.push(prompt);

  const run = async (): Promise<Query | null> => {
    // Réglages du projet seulement si le dossier est de confiance dans Claude Code.
    // Voir SECURITY.md, section Permissions.
    const settingSources = await settingSourcesFor(cwd);
    if (abortController.signal.aborted) return null;
    return query({
      prompt: input,
      options: {
        cwd,
        abortController,
        // Toujours explicite : le défaut peut être `auto`. Voir SECURITY.md, section Permissions.
        permissionMode: "default",
        canUseTool: permissionHandler(events),
        settingSources,
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        // Marque les processus lancés par noko : son hook terminal les ignore (ils passent
        // déjà par canUseTool, sans quoi chaque demande apparaîtrait deux fois).
        env: { ...process.env, [MANAGED_ENV]: "1" },
        ...(resume !== undefined ? { resume } : {}),
      },
    });
  };

  void (async () => {
    try {
      const q = await run();
      if (q === null) {
        events.onExit();
        return;
      }
      const usage: SessionUsage = { contextTokens: 0, contextWindow: null, outputTokens: 0, costUsd: null };
      for await (const msg of q) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") events.onInit(msg.session_id);
            else if (msg.subtype === "status" && msg.status === "compacting") events.onActivity({ kind: "compacting" });
            break;
          case "stream_event": {
            // Uniquement le fil principal, pas les sous-agents.
            if (msg.parent_tool_use_id !== null) break;
            const event = msg.event;
            if (event.type === "message_start") {
              events.onActivity({ kind: "thinking" });
            } else if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block.type === "thinking" || block.type === "redacted_thinking") {
                events.onActivity({ kind: "thinking" });
              } else if (block.type === "text") {
                events.onActivity({ kind: "writing" });
              } else if (TOOL_BLOCKS.has(block.type) && "name" in block && typeof block.name === "string") {
                events.onActivity({ kind: "tool", tool: block.name });
              }
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              events.onDelta(event.delta.text);
            }
            break;
          }
          case "assistant":
            if (msg.parent_tool_use_id !== null) break;
            for (const entry of assistantEntries(msg.message)) {
              if (entry.role === "tool") events.onToolUse(entry.text, entry.diff);
              else events.onAssistantText(entry.text);
            }
            usage.contextTokens = contextSize(msg.message.usage);
            events.onUsage({ ...usage });
            break;
          case "result": {
            // modelUsage et total_cost_usd sont cumulés depuis le début de query().
            const models = Object.values(msg.modelUsage);
            usage.outputTokens = models.reduce((sum, m) => sum + m.outputTokens, 0);
            const windows = models.map((m) => m.contextWindow).filter((w) => w > 0);
            usage.contextWindow = windows.length > 0 ? Math.max(...windows) : usage.contextWindow;
            usage.costUsd = msg.total_cost_usd;
            events.onUsage({ ...usage });
            events.onActivity(null);
            events.onTurnEnd(msg.is_error);
            break;
          }
        }
      }
      events.onExit();
    } catch (err) {
      events.onExit(abortController.signal.aborted ? undefined : err);
    }
  })();

  return {
    send: (message) => input.push(message),
    stop: () => {
      input.close();
      abortController.abort();
    },
  };
};

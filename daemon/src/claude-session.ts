// Une session Claude Code pilotée par le SDK Agent, en mode « streaming input » :
// la session reste ouverte et reçoit les messages suivants au fil de l'eau.

import {
  query,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Decision, PermissionAsk } from "./permissions.ts";
import { settingSourcesFor } from "./trust.ts";

export interface SessionEvents {
  /** Identifiant de session Claude Code, reçu à l'initialisation. */
  onInit(claudeSessionId: string): void;
  onDelta(text: string): void;
  onAssistantText(text: string): void;
  onTurnEnd(isError: boolean): void;
  /** Fin de la session ; `error` est défini si elle s'est terminée sur une erreur. */
  onExit(error?: unknown): void;
  /** Demande d'autorisation d'un outil : la décision vient de l'utilisateur, dans l'UI. */
  requestPermission(ask: PermissionAsk, signal: AbortSignal): Promise<Decision>;
}

export interface RunningSession {
  send(text: string): void;
  stop(): void;
}

export interface StartOptions {
  cwd: string;
  prompt: string;
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

  push(text: string): void {
    if (this.closed) return;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
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
    // Les questions interactives attendent des réponses dans `updatedInput` : pas encore gérées.
    if (toolName === "AskUserQuestion") {
      return {
        behavior: "deny",
        message: "noko ne gère pas encore les questions interactives : pose ta question dans ta réponse.",
      };
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

function assistantText(msg: Extract<SDKMessage, { type: "assistant" }>): string {
  const parts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
}

export const startClaudeSession: StartSession = ({ cwd, prompt, resume, events }) => {
  const input = new InputQueue();
  const abortController = new AbortController();
  input.push(prompt);

  const run = async (): Promise<Query | null> => {
    // Réglages du projet seulement si le dossier est de confiance dans Claude Code.
    // Voir CLAUDE.md, section Sécurité.
    const settingSources = await settingSourcesFor(cwd);
    if (abortController.signal.aborted) return null;
    return query({
      prompt: input,
      options: {
        cwd,
        abortController,
        // Toujours explicite : le défaut peut être `auto`. Voir CLAUDE.md, section Sécurité.
        permissionMode: "default",
        canUseTool: permissionHandler(events),
        settingSources,
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
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
      for await (const msg of q) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") events.onInit(msg.session_id);
            break;
          case "stream_event":
            // Uniquement le fil principal, pas les sous-agents.
            if (
              msg.parent_tool_use_id === null &&
              msg.event.type === "content_block_delta" &&
              msg.event.delta.type === "text_delta"
            ) {
              events.onDelta(msg.event.delta.text);
            }
            break;
          case "assistant":
            if (msg.parent_tool_use_id === null) {
              const text = assistantText(msg);
              if (text !== "") events.onAssistantText(text);
            }
            break;
          case "result":
            events.onTurnEnd(msg.is_error);
            break;
        }
      }
      events.onExit();
    } catch (err) {
      events.onExit(abortController.signal.aborted ? undefined : err);
    }
  })();

  return {
    send: (text) => input.push(text),
    stop: () => {
      input.close();
      abortController.abort();
    },
  };
};

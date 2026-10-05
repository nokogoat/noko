// Une session Claude Code pilotée par le SDK Agent, en mode « streaming input » :
// la session reste ouverte et reçoit les messages suivants au fil de l'eau.

import {
  query,
  type CanUseTool,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface SessionEvents {
  /** Identifiant de session Claude Code, reçu à l'initialisation. */
  onInit(claudeSessionId: string): void;
  onDelta(text: string): void;
  onAssistantText(text: string): void;
  onTurnEnd(isError: boolean): void;
  /** Fin de la session ; `error` est défini si elle s'est terminée sur une erreur. */
  onExit(error?: unknown): void;
}

export interface RunningSession {
  send(text: string): void;
  stop(): void;
}

export interface StartOptions {
  cwd: string;
  prompt: string;
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

// Étape 1 de la feuille de route : aucune approbation possible depuis noko.
// Tout outil qui demanderait une permission est refusé (l'étape 4 branchera l'UI ici).
const denyAll: CanUseTool = async () => ({
  behavior: "deny",
  message: "noko ne gère pas encore les permissions : outil refusé.",
});

function assistantText(msg: Extract<SDKMessage, { type: "assistant" }>): string {
  const parts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
}

export const startClaudeSession: StartSession = ({ cwd, prompt, events }) => {
  const input = new InputQueue();
  const abortController = new AbortController();
  input.push(prompt);

  const q = query({
    prompt: input,
    options: {
      cwd,
      abortController,
      // Toujours explicite : le défaut peut être `auto`. Voir CLAUDE.md, section Sécurité.
      permissionMode: "default",
      canUseTool: denyAll,
      // Aucun réglage lu sur le disque : un `.claude/settings.json` de projet pourrait
      // apporter des hooks ou des règles `allow`. Voir CLAUDE.md, section Sécurité.
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
    },
  });

  void (async () => {
    try {
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

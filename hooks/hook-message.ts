// Traduction entre les hooks de Claude Code et le protocole de noko (fonctions pures,
// testées dans daemon/test/hook.test.ts).

import { z } from "zod";
import { ClientMessage, type HookDecision, type HookEvent } from "../shared/protocol.ts";

const DENIED_BY_USER = "Refusé par l'utilisateur dans noko.";

// Seuls les champs utiles sont lus ; le reste de l'entrée est ignoré.
export const HookInput = z.object({
  hook_event_name: z.string(),
  session_id: z.string(),
  cwd: z.string(),
  notification_type: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
});
export type HookInput = z.infer<typeof HookInput>;

/** Événement de Claude Code → événement noko ; null : sans intérêt pour noko. */
function eventOf(input: HookInput): HookEvent | "permission" | null {
  switch (input.hook_event_name) {
    case "SessionStart":
      return "session_start";
    case "UserPromptSubmit":
      return "prompt";
    case "Stop":
    case "StopFailure":
      return "stop";
    case "Notification":
      return input.notification_type === "idle_prompt" ? "idle" : null;
    case "SessionEnd":
      return "session_end";
    case "PermissionRequest":
      return "permission";
    default:
      return null;
  }
}

export type HookMessage = Extract<ClientMessage, { type: "hook.event" | "hook.permission" }>;

/** Message pour le daemon, validé par le schéma du protocole ; null s'il est invalide. */
export function buildMessage(input: HookInput, pid: number): HookMessage | null {
  const event = eventOf(input);
  if (event === null) return null;
  const context = { claudeSessionId: input.session_id, cwd: input.cwd, pid: pid > 1 ? pid : null };
  const msg =
    event === "permission"
      ? { type: "hook.permission", ...context, toolName: input.tool_name, input: input.tool_input }
      : { type: "hook.event", event, ...context };
  const parsed = ClientMessage.safeParse(msg);
  return parsed.success && (parsed.data.type === "hook.event" || parsed.data.type === "hook.permission")
    ? parsed.data
    : null;
}

/** Sortie JSON de Claude Code pour une décision ; null : laisser le terminal demander. */
export function hookOutput(decision: HookDecision): object | null {
  if (decision === "ask") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: DENIED_BY_USER },
    },
  };
}

// Textes affichés pour l'état des sessions (dans la langue de `s`).

import type { SessionInfo, SessionUsage } from "../../shared/protocol.ts";
import type { Strings } from "./i18n.ts";

/** Ce que fait Claude, en une phrase courte ; chaîne vide s'il ne fait rien. */
export function activityText(session: SessionInfo | undefined, s: Strings): string {
  if (session === undefined) return "";
  const activity = session.activity;
  if (activity !== null) {
    switch (activity.kind) {
      case "thinking":
        return s.activity.thinking;
      case "writing":
        return s.activity.writing;
      case "tool":
        return s.activity.tool(activity.tool);
      case "permission":
        return s.activity.permission;
      case "question":
        return s.activity.question;
      case "compacting":
        return s.activity.compacting;
    }
  }
  if (session.status === "starting") return s.activity.starting;
  if (session.status === "running") return s.activity.working;
  return "";
}

/** 950 → « 950 », 19 197 → « 19 k », 1 000 000 → « 1 M ». */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")} M`;
}

export function usageText(usage: SessionUsage | null, s: Strings): string {
  if (usage === null) return "";
  const parts: string[] = [];
  if (usage.contextWindow !== null && usage.contextWindow > 0) {
    const percent = Math.round((usage.contextTokens / usage.contextWindow) * 100);
    parts.push(s.usage.context(formatTokens(usage.contextTokens), formatTokens(usage.contextWindow), percent));
  } else {
    parts.push(s.usage.contextOnly(formatTokens(usage.contextTokens)));
  }
  if (usage.outputTokens > 0) parts.push(s.usage.generated(formatTokens(usage.outputTokens)));
  return parts.join(" · ");
}

export function usageTooltip(usage: SessionUsage | null, s: Strings): string {
  if (usage === null) return "";
  const lines = [s.usage.tipContext(usage.contextTokens), s.usage.tipOutput(usage.outputTokens)];
  if (usage.costUsd !== null) lines.push(s.usage.tipCost(usage.costUsd.toFixed(2)));
  lines.push(s.usage.tipSince);
  return lines.join("\n");
}

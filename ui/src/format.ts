// Textes affichés pour l'état des sessions.

import type { SessionInfo, SessionStatus, SessionUsage } from "../../shared/protocol.ts";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "démarrage",
  running: "en cours",
  idle: "en attente",
  stopped: "arrêtée",
  error: "erreur",
};

/** Ce que fait Claude, en une phrase courte ; chaîne vide s'il ne fait rien. */
export function activityText(session: SessionInfo | undefined): string {
  if (session === undefined) return "";
  const activity = session.activity;
  if (activity !== null) {
    switch (activity.kind) {
      case "thinking":
        return "Réfléchit…";
      case "writing":
        return "Écrit…";
      case "tool":
        return `Outil : ${activity.tool}…`;
      case "permission":
        return "Attend ton autorisation";
      case "question":
        return "Te pose une question";
      case "compacting":
        return "Compacte le contexte…";
    }
  }
  if (session.status === "starting") return "Démarrage…";
  if (session.status === "running") return "Travaille…";
  return "";
}

/** 950 → « 950 », 19 197 → « 19 k », 1 000 000 → « 1 M ». */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")} M`;
}

export function usageText(usage: SessionUsage | null): string {
  if (usage === null) return "";
  const parts: string[] = [];
  if (usage.contextWindow !== null && usage.contextWindow > 0) {
    const percent = Math.round((usage.contextTokens / usage.contextWindow) * 100);
    parts.push(`Contexte ${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)} (${percent} %)`);
  } else {
    parts.push(`Contexte ${formatTokens(usage.contextTokens)}`);
  }
  if (usage.outputTokens > 0) parts.push(`${formatTokens(usage.outputTokens)} générés`);
  return parts.join(" · ");
}

export function usageTooltip(usage: SessionUsage | null): string {
  if (usage === null) return "";
  const lines = [
    `Tokens dans le contexte : ${usage.contextTokens}`,
    `Tokens générés par Claude (réflexion comprise) : ${usage.outputTokens}`,
  ];
  if (usage.costUsd !== null) {
    lines.push(`Coût estimé au tarif de l'API : ${usage.costUsd.toFixed(2)} $ (pas une facture)`);
  }
  lines.push("Depuis le dernier démarrage ou la dernière reprise de la session.");
  return lines.join("\n");
}

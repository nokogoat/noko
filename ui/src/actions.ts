// Commandes envoyées au daemon depuis l'UI.

import type { SessionInfo } from "../../shared/protocol.ts";
import { DaemonClient } from "./ipc.ts";
import { expandHome } from "./paths.ts";
import {
  applyMessage,
  connection,
  expectNewSession,
  selectedId,
  sessions,
  setConnection,
  setLastError,
  setPermissions,
  transcriptOf,
} from "./store.ts";

export const client = new DaemonClient({
  onState: (state) => {
    setConnection(state);
    if (state !== "connected") {
      historyRequested.clear();
      // Demandes périmées : l'instantané reçu à la reconnexion fait foi.
      setPermissions([]);
    }
  },
  onMessage: applyMessage,
});

// Historiques déjà demandés sur la connexion courante.
const historyRequested = new Set<string>();

const CLOSED = new Set<SessionInfo["status"]>(["stopped", "error"]);

export function isClosed(session: SessionInfo): boolean {
  return CLOSED.has(session.status);
}

/** Renvoie un message d'erreur à afficher, ou null si la commande est partie. */
export function createSession(cwd: string, prompt: string, name: string): string | null {
  const path = expandHome(cwd);
  if (!path.startsWith("/")) return "Le dossier doit être un chemin absolu.";
  if (prompt.trim() === "") return "Écris un premier message.";
  setLastError(null);
  expectNewSession();
  const trimmedName = name.trim();
  const sent = client.send({
    type: "session.create",
    cwd: path,
    prompt,
    ...(trimmedName !== "" ? { name: trimmedName } : {}),
  });
  return sent ? null : "Message refusé (daemon absent ou champ invalide).";
}

/** Envoie un message à la session : simple envoi si elle tourne, reprise sinon. */
export function sendToSession(session: SessionInfo, text: string): string | null {
  if (text.trim() === "") return null;
  setLastError(null);
  const type = isClosed(session) ? "session.resume" : "session.send";
  const sent = client.send({ type, sessionId: session.id, text });
  return sent ? null : "Message refusé (daemon absent ou champ invalide).";
}

export function stopSession(session: SessionInfo): void {
  client.send({ type: "session.stop", sessionId: session.id });
}

/** Charge l'historique de la session sélectionnée, une fois par connexion. */
export function loadSelectedHistory(): void {
  const id = selectedId.peek();
  if (id === null || connection.peek() !== "connected" || historyRequested.has(id)) return;
  const session = sessions.peek().find((s) => s.id === id);
  if (session === undefined || session.claudeSessionId === null) return;
  // Une session déjà suivie en direct par cette UI n'a pas besoin de son historique
  // (et le remplacer pendant un tour en cours ferait perdre des messages).
  const t = transcriptOf(id);
  if (t.loaded || t.entries.length > 0 || t.streaming !== "") return;
  historyRequested.add(id);
  client.send({ type: "session.history", sessionId: id });
}

export function answerPermission(requestId: string, decision: "allow" | "deny"): boolean {
  return client.send({ type: "permission.answer", requestId, decision });
}

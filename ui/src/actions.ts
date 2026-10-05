// Commandes envoyées au daemon depuis l'UI.

import type { ImageAttachment, QuestionAnswers, SessionInfo } from "../../shared/protocol.ts";
import { t } from "./i18n.ts";
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
  setQuestions,
  transcriptOf,
} from "./store.ts";

export const client = new DaemonClient({
  onState: (state) => {
    setConnection(state);
    if (state !== "connected") {
      historyRequested.clear();
      // Demandes périmées : l'instantané reçu à la reconnexion fait foi.
      setPermissions([]);
      setQuestions([]);
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
export function createSession(
  cwd: string,
  prompt: string,
  name: string,
  images: readonly ImageAttachment[] = [],
): string | null {
  const path = expandHome(cwd);
  if (!path.startsWith("/")) return t.peek().composer.absolutePath;
  if (prompt.trim() === "") return t.peek().composer.writeFirstMessage;
  setLastError(null);
  expectNewSession();
  const trimmedName = name.trim();
  const sent = client.send({
    type: "session.create",
    cwd: path,
    prompt,
    ...(images.length > 0 ? { images: [...images] } : {}),
    ...(trimmedName !== "" ? { name: trimmedName } : {}),
  });
  return sent ? null : t.peek().composer.refused;
}

/** Envoie un message à la session : simple envoi si elle tourne, reprise sinon. */
export function sendToSession(
  session: SessionInfo,
  text: string,
  images: readonly ImageAttachment[] = [],
): string | null {
  if (text.trim() === "") return images.length > 0 ? t.peek().composer.addTextToImages : null;
  setLastError(null);
  const type = isClosed(session) ? "session.resume" : "session.send";
  const sent = client.send({
    type,
    sessionId: session.id,
    text,
    ...(images.length > 0 ? { images: [...images] } : {}),
  });
  return sent ? null : t.peek().composer.refused;
}

export function stopSession(session: SessionInfo): void {
  client.send({ type: "session.stop", sessionId: session.id });
}

/** Retire la session de la liste (l'historique de Claude Code est conservé). */
export function deleteSession(session: SessionInfo): void {
  setLastError(null);
  client.send({ type: "session.delete", sessionId: session.id });
}

/** Session en cours dans un terminal : elle se pilote depuis le terminal. */
export function isLiveTerminal(session: SessionInfo): boolean {
  return session.source === "terminal" && !isClosed(session);
}

/** Met au premier plan la fenêtre du terminal (le daemon s'en charge). */
export function focusSession(session: SessionInfo): void {
  setLastError(null);
  client.send({ type: "session.focus", sessionId: session.id });
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

export function answerQuestions(requestId: string, answers: QuestionAnswers): boolean {
  return client.send({ type: "question.answer", requestId, answers });
}

export function dismissQuestions(requestId: string): boolean {
  return client.send({ type: "question.dismiss", requestId });
}

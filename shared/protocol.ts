// Protocole IPC entre l'UI et le daemon : une ligne JSON par message (NDJSON).
// Source unique des types et des schémas de validation, importée des deux côtés.
// Toute évolution du protocole commence ici.

import { z } from "zod";

/** Taille maximale d'une ligne (message), saut de ligne exclu. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Nom du fichier de socket dans $XDG_RUNTIME_DIR. */
export const SOCKET_NAME = "noko.sock";

const SessionId = z.uuid();

const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/") && !p.includes("\0"), "chemin absolu attendu");

const UserText = z.string().min(1).max(256 * 1024);

const SessionName = z.string().min(1).max(200);

export const SessionStatus = z.enum([
  "starting", // session lancée, en attente du SDK
  "running", // Claude travaille sur un tour
  "idle", // tour terminé, en attente d'un message
  "stopped", // arrêtée par l'utilisateur ou terminée
  "error", // terminée sur une erreur
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionInfo = z.strictObject({
  id: SessionId,
  /** Identifiant de session Claude Code (connu après l'init du SDK). */
  claudeSessionId: z.string().min(1).max(128).nullable(),
  name: SessionName,
  cwd: AbsolutePath,
  status: SessionStatus,
  /** Dernière activité, en millisecondes depuis l'époque Unix. */
  lastActivity: z.number().int().nonnegative(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const HistoryMessage = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type HistoryMessage = z.infer<typeof HistoryMessage>;

// --- UI → daemon -----------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("state.get") }),
  z.strictObject({
    type: z.literal("session.create"),
    cwd: AbsolutePath,
    prompt: UserText,
    name: SessionName.optional(),
  }),
  z.strictObject({
    type: z.literal("session.send"),
    sessionId: SessionId,
    text: UserText,
  }),
  /** Relance une session terminée (ou d'une session précédente du daemon) avec un message. */
  z.strictObject({
    type: z.literal("session.resume"),
    sessionId: SessionId,
    text: UserText,
  }),
  z.strictObject({
    type: z.literal("session.stop"),
    sessionId: SessionId,
  }),
  /** Demande l'historique d'une session, lu dans les transcripts de Claude Code. */
  z.strictObject({
    type: z.literal("session.history"),
    sessionId: SessionId,
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --- daemon → UI -----------------------------------------------------------

export const ErrorCode = z.enum([
  "invalid_message", // ligne illisible ou non conforme : la connexion est fermée
  "unknown_session",
  "session_closed",
  "invalid_cwd",
  "not_resumable", // aucun identifiant de session Claude Code connu
  "history_unavailable",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("state.snapshot"),
    sessions: z.array(SessionInfo),
  }),
  z.strictObject({
    type: z.literal("session.update"),
    session: SessionInfo,
  }),
  /** Fragment de texte de la réponse en cours (streaming). */
  z.strictObject({
    type: z.literal("message.delta"),
    sessionId: SessionId,
    text: z.string(),
  }),
  /** Message envoyé par l'utilisateur (renvoyé à toutes les UI connectées). */
  z.strictObject({
    type: z.literal("message.user"),
    sessionId: SessionId,
    text: z.string(),
  }),
  /** Texte complet d'un message de Claude, une fois terminé. */
  z.strictObject({
    type: z.literal("message.complete"),
    sessionId: SessionId,
    text: z.string(),
  }),
  /** Historique d'une session : les derniers messages, du plus ancien au plus récent. */
  z.strictObject({
    type: z.literal("session.history"),
    sessionId: SessionId,
    messages: z.array(HistoryMessage),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: ErrorCode,
    message: z.string().max(1000),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

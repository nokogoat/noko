// Protocole IPC entre l'UI et le daemon : une ligne JSON par message (NDJSON).
// Source unique des types et des schémas de validation, importée des deux côtés.
// Toute évolution du protocole commence ici.

import { z } from "zod";

/**
 * Taille maximale d'une ligne (message), saut de ligne exclu. 8 Mio pour les images
 * jointes (base64) : au plus 8 connexions × 8 Mio en mémoire côté daemon.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Images jointes à un message : nombre et taille (en caractères base64) maximaux. */
export const MAX_IMAGES = 4;
// 4 × 1,5 Mio + texte (256 Ki caractères, échappés) reste sous MAX_LINE_BYTES.
export const MAX_IMAGE_BASE64 = 1.5 * 1024 * 1024;

/** Nom du fichier de socket dans $XDG_RUNTIME_DIR. */
export const SOCKET_NAME = "noko.sock";

const SessionId = z.uuid();

const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith("/") && !p.includes("\0"), "chemin absolu attendu");

const UserText = z.string().min(1).max(256 * 1024);

export const ImageAttachment = z.strictObject({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z
    .string()
    .min(1)
    .max(MAX_IMAGE_BASE64)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64 attendu"),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

const Images = z.array(ImageAttachment).max(MAX_IMAGES);

const SessionName = z.string().min(1).max(200);

export const SessionStatus = z.enum([
  "starting", // session lancée, en attente du SDK
  "running", // Claude travaille sur un tour
  "idle", // tour terminé, en attente d'un message
  "stopped", // arrêtée par l'utilisateur ou terminée
  "error", // terminée sur une erreur
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Ce que fait Claude en ce moment (null : rien, en attente de l'utilisateur). */
export const SessionActivity = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thinking") }),
  z.strictObject({ kind: z.literal("writing") }),
  z.strictObject({ kind: z.literal("tool"), tool: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal("permission") }),
  z.strictObject({ kind: z.literal("compacting") }),
]);
export type SessionActivity = z.infer<typeof SessionActivity>;

const TokenCount = z.number().int().nonnegative();

/** Consommation de la session (depuis son dernier démarrage ou sa dernière reprise). */
export const SessionUsage = z.strictObject({
  /** Tokens dans le contexte lors du dernier appel au modèle. */
  contextTokens: TokenCount,
  /** Taille de la fenêtre de contexte du modèle, si connue. */
  contextWindow: TokenCount.nullable(),
  /** Tokens générés par Claude (réflexion comprise). */
  outputTokens: TokenCount,
  /** Coût estimé en dollars au tarif de l'API (pas une facture). */
  costUsd: z.number().nonnegative().nullable(),
});
export type SessionUsage = z.infer<typeof SessionUsage>;

export const SessionInfo = z.strictObject({
  id: SessionId,
  /** Identifiant de session Claude Code (connu après l'init du SDK). */
  claudeSessionId: z.string().min(1).max(128).nullable(),
  name: SessionName,
  cwd: AbsolutePath,
  status: SessionStatus,
  /** Dernière activité, en millisecondes depuis l'époque Unix. */
  lastActivity: z.number().int().nonnegative(),
  activity: SessionActivity.nullable(),
  usage: SessionUsage.nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const HistoryMessage = z.strictObject({
  /** `tool` : résumé d'un appel d'outil (nom et argument principal). */
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
});
export type HistoryMessage = z.infer<typeof HistoryMessage>;

/** Demande d'autorisation d'un outil, avec son entrée exacte (jamais un résumé). */
export const PermissionRequest = z.strictObject({
  requestId: z.uuid(),
  sessionId: SessionId,
  toolName: z.string().min(1).max(256),
  /** Entrée de l'outil, telle que Claude Code l'exécutera. */
  input: z.record(z.string(), z.json()),
  /** Phrase fournie par Claude Code (ex. « Claude wants to read foo.txt »). */
  title: z.string().max(4096).nullable(),
  /** Pourquoi Claude Code demande l'autorisation. */
  reason: z.string().max(4096).nullable(),
  /** Chemin hors des dossiers autorisés qui a déclenché la demande. */
  blockedPath: z.string().max(4096).nullable(),
  /** Au-delà (millisecondes depuis l'époque Unix), la demande est refusée. */
  expiresAt: z.number().int().nonnegative(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionOutcome = z.enum([
  "allowed",
  "denied",
  "timeout", // pas de réponse à temps : refusée
  "cancelled", // session arrêtée ou tour interrompu : refusée
]);
export type PermissionOutcome = z.infer<typeof PermissionOutcome>;

// --- UI → daemon -----------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("state.get") }),
  z.strictObject({
    type: z.literal("session.create"),
    cwd: AbsolutePath,
    prompt: UserText,
    images: Images.optional(),
    name: SessionName.optional(),
  }),
  z.strictObject({
    type: z.literal("session.send"),
    sessionId: SessionId,
    text: UserText,
    images: Images.optional(),
  }),
  /** Relance une session terminée (ou d'une session précédente du daemon) avec un message. */
  z.strictObject({
    type: z.literal("session.resume"),
    sessionId: SessionId,
    text: UserText,
    images: Images.optional(),
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
  /** Réponse à une demande d'autorisation en attente (usage unique). */
  z.strictObject({
    type: z.literal("permission.answer"),
    requestId: z.uuid(),
    decision: z.enum(["allow", "deny"]),
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
  "unknown_request", // demande d'autorisation inconnue, expirée ou déjà traitée
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("state.snapshot"),
    sessions: z.array(SessionInfo),
    permissions: z.array(PermissionRequest),
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
    /** Nombre d'images jointes (le contenu n'est pas renvoyé). */
    imageCount: z.number().int().min(0).max(MAX_IMAGES),
  }),
  /** Texte complet d'un message de Claude, une fois terminé. */
  z.strictObject({
    type: z.literal("message.complete"),
    sessionId: SessionId,
    text: z.string(),
  }),
  /** Appel d'outil par Claude, résumé pour la conversation (nom et argument principal). */
  z.strictObject({
    type: z.literal("message.tool"),
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
    type: z.literal("permission.request"),
    request: PermissionRequest,
  }),
  /** La demande n'est plus en attente (réponse, expiration ou annulation). */
  z.strictObject({
    type: z.literal("permission.resolved"),
    requestId: z.uuid(),
    sessionId: SessionId,
    outcome: PermissionOutcome,
  }),
  z.strictObject({
    type: z.literal("error"),
    code: ErrorCode,
    message: z.string().max(1000),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

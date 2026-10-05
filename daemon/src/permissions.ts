// Demandes en attente d'une réponse de l'UI (autorisations d'outils, questions).
// Règles (CLAUDE.md, section Sécurité) : identifiant aléatoire à usage unique ;
// identifiant inconnu, expiré ou déjà utilisé → refus ; pas de réponse à temps → valeur
// de repli (refus pour une autorisation, aucune réponse pour une question).

import { randomUUID } from "node:crypto";
import type { PermissionOutcome, PermissionRequest } from "../../shared/protocol.ts";
import { PermissionRequest as PermissionRequestSchema } from "../../shared/protocol.ts";

/** Champs communs à toute demande en attente. */
export interface PendingBase {
  requestId: string;
  sessionId: string;
  expiresAt: number;
}

export interface PendingEvents<R, O> {
  onRequest(request: R): void;
  onResolved(request: R, outcome: O): void;
}

/** Issues communes : expiration et annulation donnent toujours la valeur de repli. */
type EndOutcome = "timeout" | "cancelled";

interface Pending<R, A> {
  request: R;
  resolve: (answer: A) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal;
}

export class PendingBroker<R extends PendingBase, A, O extends string> {
  private readonly timeoutMs: number;
  private readonly fallback: A;
  private readonly events: PendingEvents<R, O | EndOutcome>;
  private readonly pending = new Map<string, Pending<R, A>>();

  constructor(timeoutMs: number, fallback: A, events: PendingEvents<R, O | EndOutcome>) {
    this.timeoutMs = timeoutMs;
    this.fallback = fallback;
    this.events = events;
  }

  /**
   * Publie une demande et attend la réponse. `build` reçoit l'identifiant et l'échéance
   * et renvoie la demande validée, ou null si elle n'est pas représentable : la valeur de
   * repli est alors renvoyée sans rien publier.
   */
  request(build: (requestId: string, expiresAt: number) => R | null, signal: AbortSignal): Promise<A> {
    if (signal.aborted) return Promise.resolve(this.fallback);
    const request = build(randomUUID(), Date.now() + this.timeoutMs);
    if (request === null) return Promise.resolve(this.fallback);

    return new Promise<A>((resolve) => {
      const onAbort = () => this.settle(request.requestId, this.fallback, "cancelled");
      const timer = setTimeout(() => this.settle(request.requestId, this.fallback, "timeout"), this.timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.requestId, { request, resolve, timer, onAbort, signal });
      this.events.onRequest(request);
    });
  }

  /** La demande en attente, ou undefined (inconnue, déjà traitée ou expirée). */
  get(requestId: string): R | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return undefined;
    // Échéance vérifiée ici aussi : le minuteur peut être en retard si la boucle est occupée.
    if (Date.now() > entry.request.expiresAt) {
      this.settle(requestId, this.fallback, "timeout");
      return undefined;
    }
    return entry.request;
  }

  /** Réponse de l'utilisateur. false si la demande n'est pas (ou plus) en attente. */
  answer(requestId: string, answer: A, outcome: O): boolean {
    if (this.get(requestId) === undefined) return false;
    return this.settle(requestId, answer, outcome);
  }

  /** Valeur de repli pour toutes les demandes d'une session (arrêt, fin de session). */
  cancelSession(sessionId: string): void {
    for (const { request } of [...this.pending.values()]) {
      if (request.sessionId === sessionId) this.settle(request.requestId, this.fallback, "cancelled");
    }
  }

  /** Valeur de repli pour toutes les demandes (arrêt du daemon). */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, this.fallback, "cancelled");
  }

  list(): R[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  private settle(requestId: string, answer: A, outcome: O | EndOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    // Retirée avant toute autre action : une seconde réponse ne trouve plus rien.
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(answer);
    this.events.onResolved(entry.request, outcome);
    return true;
  }
}

// --- Autorisations d'outils ------------------------------------------------

export type Decision = "allow" | "deny";

/** Ce que Claude Code demande, avant ajout de l'identifiant et de l'échéance. */
export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  reason: string | null;
  blockedPath: string | null;
}

export class PermissionBroker {
  private readonly broker: PendingBroker<PermissionRequest, Decision, "allowed" | "denied">;

  constructor(timeoutMs: number, events: PendingEvents<PermissionRequest, PermissionOutcome>) {
    this.broker = new PendingBroker<PermissionRequest, Decision, "allowed" | "denied">(timeoutMs, "deny", events);
  }

  /**
   * Publie une demande et attend la décision. Toute anomalie (entrée non
   * représentable, signal déjà annulé…) donne un refus, jamais une autorisation.
   */
  request(sessionId: string, ask: PermissionAsk, signal: AbortSignal): Promise<Decision> {
    return this.broker.request((requestId, expiresAt) => {
      const parsed = PermissionRequestSchema.safeParse({
        requestId,
        sessionId,
        toolName: ask.toolName,
        input: ask.input,
        title: ask.title,
        reason: ask.reason,
        blockedPath: ask.blockedPath,
        expiresAt,
      });
      return parsed.success ? parsed.data : null;
    }, signal);
  }

  /** Réponse de l'utilisateur. false si la demande n'est pas (ou plus) en attente. */
  answer(requestId: string, decision: Decision): boolean {
    return this.broker.answer(requestId, decision, decision === "allow" ? "allowed" : "denied");
  }

  cancelSession(sessionId: string): void {
    this.broker.cancelSession(sessionId);
  }

  cancelAll(): void {
    this.broker.cancelAll();
  }

  list(): PermissionRequest[] {
    return this.broker.list();
  }
}

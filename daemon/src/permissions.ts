// Demandes d'autorisation en attente d'une réponse de l'UI.
// Règles (CLAUDE.md, section Sécurité) : identifiant aléatoire à usage unique ;
// identifiant inconnu, expiré ou déjà utilisé → refus ; pas de réponse à temps → deny.

import { randomUUID } from "node:crypto";
import type { PermissionOutcome, PermissionRequest } from "../../shared/protocol.ts";
import { PermissionRequest as PermissionRequestSchema } from "../../shared/protocol.ts";

export type Decision = "allow" | "deny";

/** Ce que Claude Code demande, avant ajout de l'identifiant et de l'échéance. */
export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  reason: string | null;
  blockedPath: string | null;
}

export interface BrokerEvents {
  onRequest(request: PermissionRequest): void;
  onResolved(request: PermissionRequest, outcome: PermissionOutcome): void;
}

interface Pending {
  request: PermissionRequest;
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal;
}

export class PermissionBroker {
  private readonly timeoutMs: number;
  private readonly events: BrokerEvents;
  private readonly pending = new Map<string, Pending>();

  constructor(timeoutMs: number, events: BrokerEvents) {
    this.timeoutMs = timeoutMs;
    this.events = events;
  }

  /**
   * Publie une demande et attend la décision. Toute anomalie (entrée non
   * représentable, signal déjà annulé…) donne un refus, jamais une autorisation.
   */
  request(sessionId: string, ask: PermissionAsk, signal: AbortSignal): Promise<Decision> {
    if (signal.aborted) return Promise.resolve("deny");
    const parsed = PermissionRequestSchema.safeParse({
      requestId: randomUUID(),
      sessionId,
      toolName: ask.toolName,
      input: ask.input,
      title: ask.title,
      reason: ask.reason,
      blockedPath: ask.blockedPath,
      expiresAt: Date.now() + this.timeoutMs,
    });
    if (!parsed.success) return Promise.resolve("deny");
    const request = parsed.data;

    return new Promise<Decision>((resolve) => {
      const onAbort = () => this.settle(request.requestId, "deny", "cancelled");
      const timer = setTimeout(() => this.settle(request.requestId, "deny", "timeout"), this.timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.requestId, { request, resolve, timer, onAbort, signal });
      this.events.onRequest(request);
    });
  }

  /** Réponse de l'utilisateur. false si la demande n'est pas (ou plus) en attente. */
  answer(requestId: string, decision: Decision): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    // Échéance vérifiée ici aussi : le minuteur peut être en retard si la boucle est occupée.
    if (Date.now() > entry.request.expiresAt) {
      this.settle(requestId, "deny", "timeout");
      return false;
    }
    return this.settle(requestId, decision, decision === "allow" ? "allowed" : "denied");
  }

  /** Refuse toutes les demandes d'une session (arrêt, fin de session). */
  cancelSession(sessionId: string): void {
    for (const { request } of [...this.pending.values()]) {
      if (request.sessionId === sessionId) this.settle(request.requestId, "deny", "cancelled");
    }
  }

  /** Refuse toutes les demandes (arrêt du daemon). */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, "deny", "cancelled");
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  private settle(requestId: string, decision: Decision, outcome: PermissionOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    // Retirée avant toute autre action : une seconde réponse ne trouve plus rien.
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(decision);
    this.events.onResolved(entry.request, outcome);
    return true;
  }
}

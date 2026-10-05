// Questions à choix posées par Claude (outil AskUserQuestion), en attente de l'UI.

import { z } from "zod";
import {
  type Question,
  type QuestionAnswers,
  type QuestionOutcome,
  QuestionRequest,
} from "../../shared/protocol.ts";
import { PendingBroker, type PendingEvents } from "./permissions.ts";

/**
 * Entrée de l'outil AskUserQuestion, telle qu'envoyée par Claude Code. Seuls les champs
 * affichés sont gardés (les aperçus, par exemple, sont ignorés).
 */
const AskUserQuestionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().default(""),
        multiSelect: z.boolean().default(false),
        options: z.array(z.object({ label: z.string(), description: z.string().default("") })),
      }),
    )
    .min(1),
});

/** Questions extraites de l'entrée de l'outil, ou null si elle est inattendue. */
export function parseQuestions(input: unknown): Question[] | null {
  const parsed = AskUserQuestionInput.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data.questions.map((q) => ({
    question: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    options: q.options.map((o) => ({ label: o.label, description: o.description })),
  }));
}

/** Les réponses couvrent exactement les questions posées, une réponse non vide chacune. */
export function answersMatch(questions: readonly Question[], answers: QuestionAnswers): boolean {
  const asked = new Set(questions.map((q) => q.question));
  const keys = Object.keys(answers);
  return (
    keys.length === asked.size &&
    keys.every((k) => asked.has(k) && Object.hasOwn(answers, k) && answers[k]!.trim() !== "")
  );
}

export class QuestionBroker {
  private readonly broker: PendingBroker<QuestionRequest, QuestionAnswers | null, "answered" | "dismissed">;

  constructor(timeoutMs: number, events: PendingEvents<QuestionRequest, QuestionOutcome>) {
    this.broker = new PendingBroker<QuestionRequest, QuestionAnswers | null, "answered" | "dismissed">(
      timeoutMs,
      null,
      events,
    );
  }

  /** Publie les questions et attend les réponses ; null si aucune réponse. */
  ask(sessionId: string, questions: Question[], signal: AbortSignal): Promise<QuestionAnswers | null> {
    return this.broker.request((requestId, expiresAt) => {
      const parsed = QuestionRequest.safeParse({ requestId, sessionId, questions, expiresAt });
      return parsed.success ? parsed.data : null;
    }, signal);
  }

  /**
   * Réponses de l'utilisateur. "unknown" : demande inconnue, expirée ou déjà traitée ;
   * "invalid" : réponses qui ne correspondent pas aux questions (la demande reste ouverte).
   */
  answer(requestId: string, answers: QuestionAnswers): "ok" | "unknown" | "invalid" {
    const request = this.broker.get(requestId);
    if (request === undefined) return "unknown";
    if (!answersMatch(request.questions, answers)) return "invalid";
    return this.broker.answer(requestId, answers, "answered") ? "ok" : "unknown";
  }

  dismiss(requestId: string): boolean {
    return this.broker.answer(requestId, null, "dismissed");
  }

  cancelSession(sessionId: string): void {
    this.broker.cancelSession(sessionId);
  }

  cancelAll(): void {
    this.broker.cancelAll();
  }

  list(): QuestionRequest[] {
    return this.broker.list();
  }
}

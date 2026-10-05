// État affiché par l'UI. Aucune logique métier : on reflète ce que dit le daemon.

import { createMemo, createState } from "gnim";
import type {
  ErrorCode,
  HistoryMessage,
  PermissionRequest,
  QuestionRequest,
  ServerMessage,
  SessionInfo,
} from "../../shared/protocol.ts";
import { t } from "./i18n.ts";
import type { ConnectionState } from "./ipc.ts";
import { config } from "./settings.ts";
import { playSound } from "./sounds.ts";

export type Entry = HistoryMessage;

export interface Transcript {
  /** Messages terminés, dans l'ordre (utilisateur et Claude). */
  entries: readonly Entry[];
  /** Message de Claude en cours de streaming. */
  streaming: string;
  /** L'historique a été reçu du daemon. */
  loaded: boolean;
}

const EMPTY: Transcript = { entries: [], streaming: "", loaded: false };

export const [connection, setConnection] = createState<ConnectionState>("connecting");
export const [sessions, setSessions] = createState<readonly SessionInfo[]>([]);
export const [selectedId, setSelectedId] = createState<string | null>(null);
export const [transcripts, setTranscripts] = createState<ReadonlyMap<string, Transcript>>(new Map());
export const [lastError, setLastError] = createState<ErrorCode | null>(null);
/** Demandes d'autorisation en attente, dans l'ordre d'arrivée. */
export const [permissions, setPermissions] = createState<readonly PermissionRequest[]>([]);
/** Questions à choix en attente, dans l'ordre d'arrivée. */
export const [questions, setQuestions] = createState<readonly QuestionRequest[]>([]);
/** Carte ouverte (sinon : pastille). */
export const [expanded, setExpanded] = createState(false);
/** Formulaire de nouvelle session ouvert. */
export const [composing, setComposing] = createState(false);

/** Dossiers des sessions, du plus récemment actif au plus ancien, sans doublon. */
export const folders = createMemo(
  () => [...new Set(sessions().map((s) => s.cwd))],
  { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) },
);

// Après une création depuis cette UI, la prochaine nouvelle session est sélectionnée.
let selectNextNew = false;

export function expectNewSession(): void {
  selectNextNew = true;
}

const byActivity = (a: SessionInfo, b: SessionInfo) => b.lastActivity - a.lastActivity;

export function transcriptOf(id: string): Transcript {
  return transcripts.peek().get(id) ?? EMPTY;
}

function updateTranscript(id: string, change: (t: Transcript) => Transcript): void {
  const next = new Map(transcripts.peek());
  next.set(id, change(next.get(id) ?? EMPTY));
  setTranscripts(next);
}

/** Sélectionne la session la plus récente si rien (de valide) n'est sélectionné. */
function ensureSelection(list: readonly SessionInfo[]): void {
  const current = selectedId.peek();
  if (current !== null && list.some((s) => s.id === current)) return;
  setSelectedId(list[0]?.id ?? null);
}

export function applyMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "state.snapshot": {
      const list = [...msg.sessions].sort(byActivity);
      setSessions(list);
      setPermissions(msg.permissions);
      setQuestions(msg.questions);
      ensureSelection(list);
      return;
    }
    case "permission.request": {
      const others = permissions.peek().filter((p) => p.requestId !== msg.request.requestId);
      setPermissions([...others, msg.request]);
      // Une demande ne doit pas passer inaperçue : la carte s'ouvre (sans prendre le clavier).
      if (config.peek().behavior.open_on_request) setExpanded(true);
      playSound("permission");
      return;
    }
    case "question.request": {
      const others = questions.peek().filter((q) => q.requestId !== msg.request.requestId);
      setQuestions([...others, msg.request]);
      if (config.peek().behavior.open_on_request) setExpanded(true);
      playSound("question");
      return;
    }
    case "question.resolved":
      setQuestions(questions.peek().filter((q) => q.requestId !== msg.requestId));
      return;
    case "permission.resolved":
      setPermissions(permissions.peek().filter((p) => p.requestId !== msg.requestId));
      return;
    case "session.update": {
      const previous = sessions.peek();
      const before = previous.find((s) => s.id === msg.session.id)?.status;
      if ((before === "running" || before === "starting") && msg.session.status === "idle") playSound("done");
      const isNew = !previous.some((s) => s.id === msg.session.id);
      const list = [msg.session, ...previous.filter((s) => s.id !== msg.session.id)].sort(byActivity);
      setSessions(list);
      if (isNew && selectNextNew) {
        selectNextNew = false;
        setSelectedId(msg.session.id);
      } else {
        ensureSelection(list);
      }
      return;
    }
    case "session.removed": {
      const list = sessions.peek().filter((s) => s.id !== msg.sessionId);
      setSessions(list);
      const next = new Map(transcripts.peek());
      next.delete(msg.sessionId);
      setTranscripts(next);
      ensureSelection(list);
      return;
    }
    case "message.user": {
      const n = msg.imageCount;
      const text = n === 0 ? msg.text : `${msg.text}\n${t.peek().composer.imagesAttached(n)}`;
      updateTranscript(msg.sessionId, (t) => ({
        ...t,
        entries: [...t.entries, { role: "user", text }],
      }));
      return;
    }
    case "message.delta":
      updateTranscript(msg.sessionId, (t) => ({ ...t, streaming: t.streaming + msg.text }));
      return;
    case "message.tool":
      updateTranscript(msg.sessionId, (t) => ({
        ...t,
        entries: [...t.entries, { role: "tool", text: msg.text, ...(msg.diff ? { diff: msg.diff } : {}) }],
      }));
      return;
    case "message.complete":
      updateTranscript(msg.sessionId, (t) => ({
        ...t,
        entries: [...t.entries, { role: "assistant", text: msg.text }],
        streaming: "",
      }));
      return;
    case "session.history":
      // L'historique de Claude Code fait foi : il remplace ce qui était affiché.
      updateTranscript(msg.sessionId, (t) => ({ ...t, entries: msg.messages, loaded: true }));
      return;
    case "error":
      setLastError(msg.code);
      return;
  }
}

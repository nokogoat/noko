// État affiché par l'UI. Aucune logique métier : on reflète ce que dit le daemon.

import { createState } from "gnim";
import type { ErrorCode, HistoryMessage, ServerMessage, SessionInfo } from "../../shared/protocol.ts";
import type { ConnectionState } from "./ipc.ts";

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
/** Formulaire de nouvelle session ouvert. */
export const [composing, setComposing] = createState(false);

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
      ensureSelection(list);
      return;
    }
    case "session.update": {
      const previous = sessions.peek();
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
    case "message.user":
      updateTranscript(msg.sessionId, (t) => ({
        ...t,
        entries: [...t.entries, { role: "user", text: msg.text }],
      }));
      return;
    case "message.delta":
      updateTranscript(msg.sessionId, (t) => ({ ...t, streaming: t.streaming + msg.text }));
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

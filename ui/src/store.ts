// État affiché par l'UI. Aucune logique métier : on reflète ce que dit le daemon.

import { createState } from "gnim";
import type { ErrorCode, ServerMessage, SessionInfo } from "../../shared/protocol.ts";
import type { ConnectionState } from "./ipc.ts";

export interface Transcript {
  /** Messages de Claude terminés, dans l'ordre. */
  done: readonly string[];
  /** Message en cours de streaming. */
  streaming: string;
}

const EMPTY: Transcript = { done: [], streaming: "" };

export const [connection, setConnection] = createState<ConnectionState>("connecting");
export const [sessions, setSessions] = createState<readonly SessionInfo[]>([]);
export const [selectedId, setSelectedId] = createState<string | null>(null);
export const [transcripts, setTranscripts] = createState<ReadonlyMap<string, Transcript>>(new Map());
export const [lastError, setLastError] = createState<ErrorCode | null>(null);

const byActivity = (a: SessionInfo, b: SessionInfo) => b.lastActivity - a.lastActivity;

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
      const others = sessions.peek().filter((s) => s.id !== msg.session.id);
      const list = [msg.session, ...others].sort(byActivity);
      setSessions(list);
      ensureSelection(list);
      return;
    }
    case "message.delta":
      updateTranscript(msg.sessionId, (t) => ({ ...t, streaming: t.streaming + msg.text }));
      return;
    case "message.complete":
      updateTranscript(msg.sessionId, (t) => ({ done: [...t.done, msg.text], streaming: "" }));
      return;
    case "error":
      setLastError(msg.code);
      return;
  }
}

export function transcriptText(t: Transcript | undefined): string {
  if (t === undefined) return "";
  const parts = t.streaming === "" ? t.done : [...t.done, t.streaming];
  return parts.join("\n\n");
}

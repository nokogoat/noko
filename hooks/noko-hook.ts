// Hook Claude Code pour les sessions lancées dans un terminal : transmet l'événement au
// daemon, et pour une demande d'autorisation, attend la réponse donnée dans le panneau.
//
// Échoue ouvert (SECURITY.md, section Terminal hooks) : au moindre problème (daemon absent,
// socket introuvable, entrée inattendue, délai dépassé), il sort avec le code 0 sans
// rien écrire, et Claude Code demande dans le terminal comme d'habitude. Il n'écrit
// « allow » que si l'utilisateur a autorisé cette requête précise dans le panneau.

import net from "node:net";
import { resolveSocketPath } from "../daemon/src/runtime-dir.ts";
import { LineDecoder } from "../shared/line-decoder.ts";
import {
  type ClientMessage,
  MANAGED_ENV,
  MAX_LINE_BYTES,
  ServerMessage,
  TERMINAL_PERMISSION_TIMEOUT_MS,
} from "../shared/protocol.ts";
import { buildMessage, HookInput, hookOutput } from "./hook-message.ts";

/** Entrée plus grosse : laissée au terminal (le daemon refuserait la ligne). */
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
/** Durée maximale d'un événement simple, connexion comprise. */
const EVENT_DEADLINE_MS = 2000;
/** Durée maximale d'une demande d'autorisation : celle du daemon, plus une marge. */
const PERMISSION_DEADLINE_MS = TERMINAL_PERMISSION_TIMEOUT_MS + 5000;

/** Sortie sans décision : Claude Code continue comme si le hook n'existait pas. */
function pass(): never {
  process.exit(0);
}

async function readStdin(): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(msg: ClientMessage): void {
  const isPermission = msg.type === "hook.permission";
  // Filet de sécurité : quoi qu'il arrive, le hook rend la main à temps.
  setTimeout(pass, isPermission ? PERMISSION_DEADLINE_MS : EVENT_DEADLINE_MS);

  const sock = net.connect(resolveSocketPath());
  sock.on("error", pass);
  sock.on("close", pass);
  const line = JSON.stringify(msg) + "\n";
  if (!isPermission) {
    sock.end(line);
    return;
  }
  sock.write(line);
  const decoder = new LineDecoder(MAX_LINE_BYTES);
  sock.on("data", (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch {
      pass();
    }
    for (const text of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        pass();
      }
      const reply = ServerMessage.safeParse(raw);
      if (!reply.success) pass();
      if (reply.data.type === "error") pass();
      if (reply.data.type !== "hook.decision") continue;
      const output = hookOutput(reply.data.decision);
      if (output !== null) process.stdout.write(JSON.stringify(output));
      pass();
    }
  });
}

async function main(): Promise<void> {
  // Session lancée par noko : ses demandes passent déjà par le panneau (canUseTool).
  if (process.env[MANAGED_ENV] === "1") pass();
  const text = await readStdin();
  if (text === null) pass();
  const input = HookInput.safeParse(JSON.parse(text));
  if (!input.success) pass();
  // Exécution directe (forme « exec » dans settings.json) : le parent est `claude`.
  const msg = buildMessage(input.data, process.ppid);
  if (msg === null) pass();
  send(msg);
}

main().catch(pass);

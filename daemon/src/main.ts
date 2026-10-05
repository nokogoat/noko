// Point d'entrée du daemon noko.

import { startClaudeSession } from "./claude-session.ts";
import { Daemon } from "./daemon.ts";
import { loadHistory } from "./history.ts";
import { errorFields, log } from "./log.ts";
import { resolveSocketPath } from "./runtime-dir.ts";
import { dataDir, SessionStore } from "./session-store.ts";
import { terminalDeps } from "./terminal.ts";

function fail(err: unknown): never {
  // Message sans donnée sensible : il décrit seulement la vérification qui a échoué.
  process.stderr.write(`noko : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let socketPath: string;
  let store: SessionStore;
  // umask restreint uniquement pendant la création de la base (SQLite donne ensuite à ses
  // journaux les droits de la base). Pas de umask global : il serait hérité par Claude
  // Code, et tous les fichiers créés dans les projets de l'utilisateur seraient en 0600.
  const previousUmask = process.umask(0o077);
  try {
    socketPath = resolveSocketPath();
    store = new SessionStore(dataDir());
  } catch (err) {
    fail(err);
  } finally {
    process.umask(previousUmask);
  }

  const daemon = new Daemon(socketPath, {
    startSession: startClaudeSession,
    loadHistory,
    store,
    terminal: terminalDeps,
  });
  try {
    await daemon.start();
  } catch (err) {
    fail(err);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("daemon.stopping", { signal });
    daemon
      .stop()
      .then(() => store.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          log("daemon.stop_failed", errorFields(err));
          process.exit(1);
        },
      );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  log("daemon.started", { pid: process.pid });
}

void main();

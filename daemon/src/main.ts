// Point d'entrée du daemon noko.

import { startClaudeSession } from "./claude-session.ts";
import { Daemon } from "./daemon.ts";
import { loadHistory } from "./history.ts";
import { errorFields, log } from "./log.ts";
import { resolveSocketPath } from "./runtime-dir.ts";
import { dataDir, SessionStore } from "./session-store.ts";

function fail(err: unknown): never {
  // Message sans donnée sensible : il décrit seulement la vérification qui a échoué.
  process.stderr.write(`noko : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // Tout fichier créé par le daemon (base SQLite, journaux WAL…) est privé.
  process.umask(0o077);

  let socketPath: string;
  let store: SessionStore;
  try {
    socketPath = resolveSocketPath();
    store = new SessionStore(dataDir());
  } catch (err) {
    fail(err);
  }

  const daemon = new Daemon(socketPath, { startSession: startClaudeSession, loadHistory, store });
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

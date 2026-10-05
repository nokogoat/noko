// Persistance de la liste des sessions (pas de leur contenu : l'historique reste
// celui de Claude Code, dans ~/.claude/projects/).

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
import { SessionInfo } from "../../shared/protocol.ts";

/** ~/.local/share/noko (ou $XDG_DATA_HOME/noko, si la variable est un chemin absolu). */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME;
  return join(base !== undefined && isAbsolute(base) ? base : join(homedir(), ".local", "share"), "noko");
}

// Les lignes relues sont validées comme toute entrée : la base peut avoir été modifiée.
const Row = z.object({
  id: z.string(),
  claude_session_id: z.string().nullable(),
  name: z.string(),
  cwd: z.string(),
  last_activity: z.number(),
});

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly upsertStmt: StatementSync;
  private readonly allStmt: StatementSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, "sessions.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        last_activity INTEGER NOT NULL
      ) STRICT;
    `);
    this.upsertStmt = this.db.prepare(`
      INSERT INTO sessions (id, claude_session_id, name, cwd, last_activity)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        claude_session_id = excluded.claude_session_id,
        name = excluded.name,
        cwd = excluded.cwd,
        last_activity = excluded.last_activity
    `);
    this.allStmt = this.db.prepare(
      "SELECT id, claude_session_id, name, cwd, last_activity FROM sessions ORDER BY last_activity DESC",
    );
  }

  save(info: SessionInfo): void {
    this.upsertStmt.run(info.id, info.claudeSessionId, info.name, info.cwd, info.lastActivity);
  }

  /** Sessions enregistrées, toutes marquées « stopped » (aucune ne tourne au démarrage). */
  load(): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const raw of this.allStmt.all()) {
      const row = Row.safeParse(raw);
      if (!row.success) continue;
      const info = SessionInfo.safeParse({
        id: row.data.id,
        claudeSessionId: row.data.claude_session_id,
        name: row.data.name,
        cwd: row.data.cwd,
        status: "stopped",
        lastActivity: row.data.last_activity,
      });
      if (info.success) sessions.push(info.data);
    }
    return sessions;
  }

  close(): void {
    this.db.close();
  }
}

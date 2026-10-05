// Notifications du bureau (Gio.Notification, via le service du bureau : swaync, mako…).
// Seulement quand la carte est fermée. Jamais de contenu de conversation : le gestionnaire de
// notifications peut garder un historique. Un clic ouvre la carte sur la session concernée.

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import type { SessionInfo } from "../../shared/protocol.ts";
import { t } from "./i18n.ts";
import { config } from "./settings.ts";
import { expanded } from "./store.ts";

/** Action de l'application appelée au clic, avec l'identifiant de la session. */
export const SHOW_SESSION_ACTION = "show-session";

export type NotifyKind = "done" | "error" | "permission" | "question";

/** Notifications affichées, par session (une seule à la fois par session). */
const shown = new Set<string>();

/**
 * Texte venant de l'extérieur (nom de session, d'outil) : certains services interprètent le
 * balisage dans les notifications. On retire ce qui pourrait en former, et on borne la longueur.
 */
function plain(text: string, max = 80): string {
  const cleaned = text.replace(/[<>&]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function notify(kind: NotifyKind, session: SessionInfo | undefined, tool: string | null = null): void {
  const settings = config.peek().notifications;
  if (!settings.enabled || expanded.peek()) return;
  const wanted = kind === "done" || kind === "error" ? settings.done : settings.requests;
  if (!wanted || session === undefined) return;
  const app = Gio.Application.get_default();
  if (app === null) return;

  const s = t.peek().notify;
  const name = plain(session.name);
  const titles: Record<NotifyKind, string> = {
    done: s.done(name),
    error: s.error(name),
    permission: s.permission(name),
    question: s.question(name),
  };
  const notification = new Gio.Notification();
  notification.set_title(titles[kind]);
  if (kind === "done") notification.set_body(s.doneBody);
  if (kind === "permission" && tool !== null) notification.set_body(s.permissionBody(plain(tool, 60)));
  notification.set_priority(
    kind === "permission" || kind === "question" ? Gio.NotificationPriority.HIGH : Gio.NotificationPriority.NORMAL,
  );
  const target = new GLib.Variant("s", session.id);
  notification.set_default_action_and_target(`app.${SHOW_SESSION_ACTION}`, target);
  notification.add_button_with_target(s.open, `app.${SHOW_SESSION_ACTION}`, target);

  // Même identifiant pour une session : la nouvelle notification remplace l'ancienne.
  const id = `session-${session.id}`;
  app.send_notification(id, notification);
  shown.add(id);
}

/** Carte ouverte : les notifications en cours n'ont plus lieu d'être. */
export function withdrawAll(): void {
  const app = Gio.Application.get_default();
  if (app === null) return;
  for (const id of shown) app.withdraw_notification(id);
  shown.clear();
}

// Carte d'une demande d'autorisation. Règles (CLAUDE.md, section Sécurité) :
// l'entrée exacte de l'outil est affichée champ par champ, jamais un résumé ;
// pas de bouton « tout autoriser » ; texte brut uniquement.

import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, createState, onCleanup } from "gnim";
import type { PermissionRequest } from "../../shared/protocol.ts";
import { answerPermission } from "./actions.ts";
import { sessions } from "./store.ts";

/** Délai avant de pouvoir autoriser : évite le clic sur une carte apparue sous la souris. */
const ARM_DELAY_MS = 800;
const FIELDS_MAX_HEIGHT = 280;

/** Valeur affichée telle quelle : chaîne brute, sinon JSON indenté. */
function displayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function Field({ name, value }: { name: string; value: unknown }) {
  return (
    <Gtk.Box class={`field field-${name.replace(/[^a-z0-9_-]/gi, "")}`} orientation={Gtk.Orientation.VERTICAL}>
      <Gtk.Label class="field-name" label={name} useMarkup={false} xalign={0} />
      <Gtk.Label
        class="field-value"
        label={displayValue(value)}
        useMarkup={false}
        wrap
        wrapMode={Pango.WrapMode.CHAR}
        xalign={0}
      />
    </Gtk.Box>
  );
}

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const [armed, setArmed] = createState(false);
  const [answered, setAnswered] = createState(false);

  const canAllow = createComputed(() => armed() && !answered());

  let armSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARM_DELAY_MS, () => {
    armSource = 0;
    setArmed(true);
    return GLib.SOURCE_REMOVE;
  });
  onCleanup(() => {
    if (armSource !== 0) GLib.source_remove(armSource);
  });

  const answer = (decision: "allow" | "deny") => {
    if (answered.peek()) return;
    // Désactivée jusqu'à la confirmation du daemon (permission.resolved retire la carte).
    if (answerPermission(request.requestId, decision)) setAnswered(true);
  };

  const session = sessions.peek().find((s) => s.id === request.sessionId);
  const sessionName = session?.name ?? "session";
  const fromTerminal = session?.source === "terminal";
  const remaining = request.expiresAt - Date.now();
  // Session terminal : sans réponse, c'est le terminal qui demande (pas de refus).
  const deadline = fromTerminal
    ? `Sinon, le terminal demandera dans ${Math.max(1, Math.ceil(remaining / 1000))} s`
    : `Refus automatique dans ${Math.max(1, Math.ceil(remaining / 60_000))} min`;

  return (
    <Gtk.Box class="permission" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      <Gtk.Label
        class="permission-title"
        label={request.title ?? `Claude veut utiliser ${request.toolName}`}
        useMarkup={false}
        wrap
        xalign={0}
      />
      <Gtk.Label
        class="permission-meta"
        label={`${sessionName}${fromTerminal ? " (terminal)" : ""} · ${request.toolName}`}
        useMarkup={false}
        ellipsize={Pango.EllipsizeMode.END}
        xalign={0}
      />
      {request.reason !== null ? (
        <Gtk.Label class="permission-meta" label={`Raison : ${request.reason}`} useMarkup={false} wrap xalign={0} />
      ) : null}
      {request.blockedPath !== null ? (
        <Gtk.Label
          class="permission-warning"
          label={`Hors des dossiers autorisés : ${request.blockedPath}`}
          useMarkup={false}
          wrap
          wrapMode={Pango.WrapMode.CHAR}
          xalign={0}
        />
      ) : null}
      <Gtk.ScrolledWindow
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        propagateNaturalHeight
        maxContentHeight={FIELDS_MAX_HEIGHT}
      >
        <Gtk.Box class="fields" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
          {Object.entries(request.input).map(([name, value]) => (
            <Field name={name} value={value} />
          ))}
        </Gtk.Box>
      </Gtk.ScrolledWindow>
      <Gtk.Box spacing={6}>
        <Gtk.Label
          class="permission-meta"
          label={deadline}
          hexpand
          xalign={0}
        />
        <Gtk.Button class="deny" label="Refuser" sensitive={answered((a) => !a)} onClicked={() => answer("deny")} />
        <Gtk.Button
          class="allow"
          label="Autoriser"
          sensitive={canAllow}
          onClicked={() => answer("allow")}
        />
      </Gtk.Box>
    </Gtk.Box>
  );
}

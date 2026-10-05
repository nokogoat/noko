// Carte d'une demande d'autorisation. Règles (SECURITY.md, section Permissions) :
// l'entrée exacte de l'outil est affichée champ par champ, jamais un résumé ;
// pas de bouton « tout autoriser » ; texte brut uniquement. Pour Edit et Write, l'avant/après
// s'y ajoute ; les champs de contenu restent à un clic (ouverts si le diff est incomplet).

import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, createState, onCleanup } from "gnim";
import type { PermissionRequest } from "../../shared/protocol.ts";
import { answerPermission } from "./actions.ts";
import { DiffView } from "./DiffView.tsx";
import { t } from "./i18n.ts";
import { sessions } from "./store.ts";

/** Délai avant de pouvoir autoriser : évite le clic sur une carte apparue sous la souris. */
const ARM_DELAY_MS = 800;
const FIELDS_MAX_HEIGHT = 280;
/** Champs dont l'avant/après tient lieu d'affichage principal. */
const CONTENT_FIELDS = new Set(["old_string", "new_string", "content"]);

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
  const deadline = t((s) =>
    fromTerminal
      ? s.permission.terminalDeadline(Math.max(1, Math.ceil(remaining / 1000)))
      : s.permission.denyDeadline(Math.max(1, Math.ceil(remaining / 60_000))),
  );

  return (
    <Gtk.Box class="permission" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      <Gtk.Label
        class="permission-title"
        label={t((s) => request.title ?? s.permission.title(request.toolName))}
        useMarkup={false}
        wrap
        xalign={0}
      />
      <Gtk.Label
        class="permission-meta"
        label={t((s) => `${sessionName}${fromTerminal ? ` ${s.permission.fromTerminal}` : ""} · ${request.toolName}`)}
        useMarkup={false}
        ellipsize={Pango.EllipsizeMode.END}
        xalign={0}
      />
      {request.reason !== null ? (
        <Gtk.Label
          class="permission-meta"
          label={t((s) => s.permission.reason(request.reason ?? ""))}
          useMarkup={false}
          wrap
          xalign={0}
        />
      ) : null}
      {request.blockedPath !== null ? (
        <Gtk.Label
          class="permission-warning"
          label={t((s) => s.permission.blockedPath(request.blockedPath ?? ""))}
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
          {request.diff !== null ? <DiffView diff={request.diff} /> : null}
          {Object.entries(request.input)
            .filter(([name]) => request.diff === null || !CONTENT_FIELDS.has(name))
            .map(([name, value]) => (
              <Field name={name} value={value} />
            ))}
          {request.diff !== null ? (
            <Gtk.Expander
              class="raw-input"
              label={t((s) => s.permission.exactInput)}
              expanded={request.diff.truncated}
            >
              <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
                {Object.entries(request.input)
                  .filter(([name]) => CONTENT_FIELDS.has(name))
                  .map(([name, value]) => (
                    <Field name={name} value={value} />
                  ))}
              </Gtk.Box>
            </Gtk.Expander>
          ) : null}
        </Gtk.Box>
      </Gtk.ScrolledWindow>
      <Gtk.Box spacing={6}>
        <Gtk.Label
          class="permission-meta"
          label={deadline}
          hexpand
          xalign={0}
        />
        <Gtk.Button
          class="deny"
          label={t((s) => s.permission.deny)}
          sensitive={answered((a) => !a)}
          onClicked={() => answer("deny")}
        />
        <Gtk.Button
          class="allow"
          label={t((s) => s.permission.allow)}
          sensitive={canAllow}
          onClicked={() => answer("allow")}
        />
      </Gtk.Box>
    </Gtk.Box>
  );
}

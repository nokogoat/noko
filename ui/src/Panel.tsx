// Panneau layer-shell : liste des sessions et réponse en cours de la session choisie.
// Tout texte venant de Claude est affiché en texte brut (jamais de balisage Pango).

import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, For, With } from "gnim";
import type { SessionInfo, SessionStatus } from "../../shared/protocol.ts";
import type { ConnectionState } from "./ipc.ts";
import {
  connection,
  selectedId,
  sessions,
  setSelectedId,
  transcriptText,
  transcripts,
} from "./store.ts";

const PANEL_WIDTH = 420;

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "connexion…",
  connected: "connecté",
  disconnected: "daemon absent",
  unavailable: "XDG_RUNTIME_DIR manquant",
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "démarrage",
  running: "en cours",
  idle: "en attente",
  stopped: "arrêtée",
  error: "erreur",
};

function setupLayerShell(win: Gtk.Window): void {
  LayerShell.init_for_window(win);
  LayerShell.set_namespace(win, "noko");
  LayerShell.set_layer(win, LayerShell.Layer.TOP);
  LayerShell.set_anchor(win, LayerShell.Edge.TOP, true);
  LayerShell.set_anchor(win, LayerShell.Edge.RIGHT, true);
  LayerShell.set_anchor(win, LayerShell.Edge.BOTTOM, true);
  // Pas encore de champ de saisie : le panneau ne prend jamais le clavier.
  // L'étape 3 passera en ON_DEMAND, uniquement au clic dans le champ.
  LayerShell.set_keyboard_mode(win, LayerShell.KeyboardMode.NONE);
}

/** Garde la vue collée en bas pendant le streaming, sauf si l'utilisateur a remonté. */
function stickToBottom(scrolled: Gtk.ScrolledWindow): void {
  const adj = scrolled.get_vadjustment();
  let atBottom = true;
  adj.connect("value-changed", () => {
    atBottom = adj.get_value() >= adj.get_upper() - adj.get_page_size() - 2;
  });
  adj.connect("changed", () => {
    if (atBottom) adj.set_value(adj.get_upper() - adj.get_page_size());
  });
}

function SessionRow({ session }: { session: SessionInfo }) {
  const cls = selectedId((id) =>
    ["session", `status-${session.status}`, id === session.id ? "selected" : ""].join(" ").trim(),
  );
  return (
    <Gtk.Button class={cls} onClicked={() => setSelectedId(session.id)}>
      <Gtk.Box spacing={8}>
        <Gtk.Label
          class="session-name"
          label={session.name}
          useMarkup={false}
          hexpand
          xalign={0}
          ellipsize={Pango.EllipsizeMode.END}
        />
        <Gtk.Label class="session-status" label={STATUS_LABEL[session.status]} useMarkup={false} />
      </Gtk.Box>
    </Gtk.Button>
  );
}

export function Panel({ app }: { app: Gtk.Application }) {
  const text = createComputed(() => {
    const id = selectedId();
    return id === null ? "" : transcriptText(transcripts().get(id));
  });

  return (
    <Gtk.ApplicationWindow
      application={app}
      title="noko"
      class="noko-panel"
      defaultWidth={PANEL_WIDTH}
      $={(win) => {
        setupLayerShell(win);
        win.present();
      }}
    >
      <Gtk.Box class="panel" orientation={Gtk.Orientation.VERTICAL}>
        <Gtk.Box class="header" spacing={8}>
          <Gtk.Label class="title" label="noko" hexpand xalign={0} />
          <Gtk.Label
            class={connection((c) => `connection ${c}`)}
            label={connection((c) => CONNECTION_LABEL[c])}
          />
        </Gtk.Box>

        <Gtk.Box class="sessions" orientation={Gtk.Orientation.VERTICAL}>
          <With value={sessions((list) => list.length === 0)}>
            {(empty) => (empty ? <Gtk.Label class="empty" label="Aucune session" xalign={0} /> : null)}
          </With>
          <For each={sessions}>{(session) => <SessionRow session={session} />}</For>
        </Gtk.Box>

        <Gtk.ScrolledWindow
          class="transcript-scroll"
          vexpand
          hscrollbarPolicy={Gtk.PolicyType.NEVER}
          $={stickToBottom}
        >
          <Gtk.Label
            class="transcript"
            label={text}
            useMarkup={false}
            wrap
            wrapMode={Pango.WrapMode.WORD_CHAR}
            xalign={0}
            yalign={0}
            valign={Gtk.Align.START}
          />
        </Gtk.ScrolledWindow>
      </Gtk.Box>
    </Gtk.ApplicationWindow>
  );
}

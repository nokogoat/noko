// Panneau layer-shell : liste des sessions, conversation de la session choisie et
// zone de saisie. Tout texte venant de Claude est affiché en texte brut (jamais de
// balisage Pango).

import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, For, With } from "gnim";
import type { SessionInfo, SessionStatus } from "../../shared/protocol.ts";
import { Composer } from "./Composer.tsx";
import type { ConnectionState } from "./ipc.ts";
import { releaseKeyboardWhenDone } from "./keyboard.ts";
import { shortenPath } from "./paths.ts";
import { PermissionCard } from "./PermissionCard.tsx";
import {
  composing,
  connection,
  folders,
  permissions,
  selectedId,
  sessions,
  setComposing,
  setSelectedId,
  transcripts,
  type Entry,
} from "./store.ts";

const PANEL_WIDTH = 420;
const SESSIONS_MAX_HEIGHT = 220;

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
  // Par défaut, le panneau ne prend jamais le clavier : seulement au clic dans un
  // champ de saisie (voir keyboard.ts).
  LayerShell.set_keyboard_mode(win, LayerShell.KeyboardMode.NONE);
  releaseKeyboardWhenDone(win);
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
        <Gtk.Label
          class="session-permission"
          label="autorisation ?"
          visible={permissions((list) => list.some((p) => p.sessionId === session.id))}
        />
        <Gtk.Label class="session-status" label={STATUS_LABEL[session.status]} useMarkup={false} />
      </Gtk.Box>
    </Gtk.Button>
  );
}

/** Un dossier de projet, dépliable, avec ses sessions. */
function FolderGroup({ cwd }: { cwd: string }) {
  const list = sessions((all) => all.filter((s) => s.cwd === cwd));
  const label = list((l) => `${shortenPath(cwd)}  (${l.length})`);
  return (
    <Gtk.Expander class="folder" expanded tooltipText={cwd}>
      <Gtk.Label
        $type="label"
        class="folder-name"
        label={label}
        useMarkup={false}
        ellipsize={Pango.EllipsizeMode.START}
        xalign={0}
      />
      <Gtk.Box class="folder-sessions" orientation={Gtk.Orientation.VERTICAL}>
        <For each={list}>{(session) => <SessionRow session={session} />}</For>
      </Gtk.Box>
    </Gtk.Expander>
  );
}

/** Où se trouve la session choisie : chemin complet du dossier et nom. */
function Location() {
  const text = createComputed(() => {
    const id = selectedId();
    const session = sessions().find((s) => s.id === id);
    return session === undefined ? "" : `${shortenPath(session.cwd)}  ›  ${session.name}`;
  });
  return (
    <Gtk.Label
      class="location"
      label={text}
      visible={text((t) => t !== "")}
      useMarkup={false}
      ellipsize={Pango.EllipsizeMode.START}
      xalign={0}
    />
  );
}

function Message({ entry }: { entry: Entry }) {
  return (
    <Gtk.Label
      class={`message ${entry.role}`}
      label={entry.text}
      useMarkup={false}
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
    />
  );
}

function Conversation() {
  const transcript = createComputed(() => {
    const id = selectedId();
    return id === null ? undefined : transcripts().get(id);
  });
  const entries = transcript((t) => t?.entries ?? []);
  const streaming = transcript((t) => t?.streaming ?? "");

  return (
    <Gtk.ScrolledWindow
      class="transcript-scroll"
      vexpand
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      $={stickToBottom}
    >
      <Gtk.Box class="transcript" orientation={Gtk.Orientation.VERTICAL} spacing={8} valign={Gtk.Align.START}>
        <For each={entries}>{(entry) => <Message entry={entry} />}</For>
        <Gtk.Label
          class="message assistant streaming"
          label={streaming}
          visible={streaming((s) => s !== "")}
          useMarkup={false}
          wrap
          wrapMode={Pango.WrapMode.WORD_CHAR}
          xalign={0}
        />
      </Gtk.Box>
    </Gtk.ScrolledWindow>
  );
}

export function Panel({ app }: { app: Gtk.Application }) {
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
      <Gtk.Box class="panel" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
        <Gtk.Box class="header" spacing={8}>
          <Gtk.Label class="title" label="noko" hexpand xalign={0} />
          <Gtk.Label
            class={connection((c) => `connection ${c}`)}
            label={connection((c) => CONNECTION_LABEL[c])}
          />
          <Gtk.Button
            class="new"
            label={composing((c) => (c ? "×" : "+"))}
            tooltipText="Nouvelle session"
            onClicked={() => setComposing(!composing.peek())}
          />
        </Gtk.Box>

        <Gtk.ScrolledWindow
          hscrollbarPolicy={Gtk.PolicyType.NEVER}
          propagateNaturalHeight
          maxContentHeight={SESSIONS_MAX_HEIGHT}
        >
          <Gtk.Box class="sessions" orientation={Gtk.Orientation.VERTICAL}>
            <With value={sessions((list) => list.length === 0)}>
              {(empty) => (empty ? <Gtk.Label class="empty" label="Aucune session" xalign={0} /> : null)}
            </With>
            <For each={folders}>{(cwd) => <FolderGroup cwd={cwd} />}</For>
          </Gtk.Box>
        </Gtk.ScrolledWindow>

        <Gtk.Box
          class="permissions"
          orientation={Gtk.Orientation.VERTICAL}
          spacing={8}
          visible={permissions((list) => list.length > 0)}
        >
          <For each={permissions}>{(request) => <PermissionCard request={request} />}</For>
        </Gtk.Box>

        <Location />
        <Conversation />
        <Composer />
      </Gtk.Box>
    </Gtk.ApplicationWindow>
  );
}

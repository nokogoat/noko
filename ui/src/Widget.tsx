// Fenêtre layer-shell en bas à gauche : une pastille qui s'ouvre en petite carte.
// Tout texte venant de Claude est affiché en texte brut (jamais de balisage Pango).

import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, createMemo, For } from "gnim";
import type { SessionInfo } from "../../shared/protocol.ts";
import { Composer } from "./Composer.tsx";
import { activityText, STATUS_LABEL, usageText, usageTooltip } from "./format.ts";
import { releaseKeyboardWhenDone, releaseKeyboard } from "./keyboard.ts";
import { shortenPath } from "./paths.ts";
import { PermissionCard } from "./PermissionCard.tsx";
import {
  composing,
  connection,
  expanded,
  permissions,
  selectedId,
  sessions,
  setComposing,
  setExpanded,
  setSelectedId,
  transcripts,
  type Entry,
} from "./store.ts";

const MARGIN = 12;
const CARD_WIDTH = 380;
const CARD_HEIGHT = 480;

const selectedSession = createComputed(() => {
  const id = selectedId();
  return sessions().find((s) => s.id === id);
});

function setupLayerShell(win: Gtk.Window): void {
  LayerShell.init_for_window(win);
  LayerShell.set_namespace(win, "noko");
  LayerShell.set_layer(win, LayerShell.Layer.TOP);
  LayerShell.set_anchor(win, LayerShell.Edge.BOTTOM, true);
  LayerShell.set_anchor(win, LayerShell.Edge.LEFT, true);
  LayerShell.set_margin(win, LayerShell.Edge.BOTTOM, MARGIN);
  LayerShell.set_margin(win, LayerShell.Edge.LEFT, MARGIN);
  // Par défaut, jamais le clavier : seulement au clic dans un champ (voir keyboard.ts).
  LayerShell.set_keyboard_mode(win, LayerShell.KeyboardMode.NONE);
  releaseKeyboardWhenDone(win);
  // GTK n'agrandit pas seulement : on lui demande la plus petite taille à chaque bascule,
  // pour que la fenêtre épouse la pastille une fois la carte fermée.
  expanded.subscribe(() => {
    if (!expanded.peek()) releaseKeyboard(win);
    win.set_default_size(1, 1);
  });
}

/** Libellé d'une session dans le menu : dossier, nom et état (deux « test » se distinguent). */
function sessionLabel(s: SessionInfo): string {
  return `${shortenPath(s.cwd)}  ›  ${s.name}  ·  ${STATUS_LABEL[s.status]}`;
}

/** Menu déroulant des sessions. */
function SessionPicker() {
  const model = new Gtk.StringList();
  let ids: string[] = [];
  let syncing = false;
  // Ne reconstruit le menu que si un libellé change (pas à chaque mise à jour d'activité).
  const labels = createMemo(() => sessions().map((s) => [s.id, sessionLabel(s)] as const), {
    equals: (a, b) => a.length === b.length && a.every(([id, l], i) => id === b[i]?.[0] && l === b[i]?.[1]),
  });

  return (
    <Gtk.DropDown
      class="session-picker"
      hexpand
      model={model}
      tooltipText="Session affichée"
      $={(self) => {
        const sync = () => {
          syncing = true;
          const list = labels.peek();
          ids = list.map(([id]) => id);
          model.splice(0, model.get_n_items(), list.map(([, label]) => label));
          const index = ids.indexOf(selectedId.peek() ?? "");
          self.set_selected(index === -1 ? Gtk.INVALID_LIST_POSITION : index);
          syncing = false;
        };
        sync();
        labels.subscribe(sync);
        selectedId.subscribe(sync);
        self.connect("notify::selected", () => {
          if (syncing) return;
          const id = ids[self.get_selected()];
          if (id !== undefined) setSelectedId(id);
        });
      }}
    />
  );
}

function Message({ entry }: { entry: Entry }) {
  return (
    <Gtk.Label
      class={`message ${entry.role}`}
      label={entry.role === "tool" ? `▸ ${entry.text}` : entry.text}
      useMarkup={false}
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
    />
  );
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

function Conversation() {
  const transcript = createComputed(() => {
    const id = selectedId();
    return id === null ? undefined : transcripts().get(id);
  });
  const entries = transcript((t) => t?.entries ?? []);
  const streaming = transcript((t) => t?.streaming ?? "");

  return (
    <Gtk.ScrolledWindow class="transcript-scroll" vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER} $={stickToBottom}>
      <Gtk.Box class="transcript" orientation={Gtk.Orientation.VERTICAL} spacing={6} valign={Gtk.Align.START}>
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

/** Ce que fait Claude en ce moment, avec un indicateur animé. */
function ActivityLine() {
  const text = selectedSession(activityText);
  return (
    <Gtk.Box class="activity" spacing={6} visible={text((t) => t !== "")}>
      <Gtk.Spinner spinning={text((t) => t !== "")} />
      <Gtk.Label label={text} useMarkup={false} ellipsize={Pango.EllipsizeMode.END} xalign={0} />
    </Gtk.Box>
  );
}

function Card() {
  const usage = selectedSession((s) => s?.usage ?? null);
  return (
    <Gtk.Box
      class="card"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={8}
      widthRequest={CARD_WIDTH}
      heightRequest={CARD_HEIGHT}
      visible={expanded}
    >
      <Gtk.Box class="header" spacing={6}>
        <SessionPicker />
        <Gtk.Button
          class="icon"
          label={composing((c) => (c ? "×" : "+"))}
          tooltipText="Nouvelle session"
          onClicked={() => setComposing(!composing.peek())}
        />
        <Gtk.Button class="icon" label="–" tooltipText="Réduire" onClicked={() => setExpanded(false)} />
      </Gtk.Box>
      <Gtk.Label
        class="usage"
        label={usage(usageText)}
        tooltipText={usage(usageTooltip)}
        visible={usage((u) => u !== null)}
        xalign={0}
      />
      <Gtk.ScrolledWindow
        class="permissions"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        propagateNaturalHeight
        maxContentHeight={CARD_HEIGHT / 2}
        visible={permissions((list) => list.length > 0)}
      >
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <For each={permissions}>{(request) => <PermissionCard request={request} />}</For>
        </Gtk.Box>
      </Gtk.ScrolledWindow>
      <Conversation />
      <ActivityLine />
      <Composer />
    </Gtk.Box>
  );
}

/** Pastille : état d'ensemble en un coup d'œil ; un clic ouvre la carte. */
function Pill() {
  const state = createComputed(() => {
    if (connection() !== "connected") return { cls: "offline", text: "daemon absent" };
    const pending = permissions().length;
    if (pending > 0) return { cls: "permission", text: pending > 1 ? `${pending} autorisations` : "autorisation requise" };
    const busy = sessions().find((s) => s.status === "running" || s.status === "starting");
    if (busy !== undefined) return { cls: "busy", text: activityText(busy) || "travaille…" };
    return { cls: "ready", text: "prêt" };
  });
  return (
    <Gtk.Button class={state((s) => `pill ${s.cls}`)} visible={expanded((e) => !e)} onClicked={() => setExpanded(true)}>
      <Gtk.Box spacing={8}>
        <Gtk.Label class="dot" label="●" />
        <Gtk.Label class="name" label="noko" />
        <Gtk.Label class="state" label={state((s) => s.text)} useMarkup={false} />
      </Gtk.Box>
    </Gtk.Button>
  );
}

export function Widget({ app }: { app: Gtk.Application }) {
  return (
    <Gtk.ApplicationWindow
      application={app}
      title="noko"
      class="noko-widget"
      $={(win) => {
        setupLayerShell(win);
        win.present();
      }}
    >
      <Gtk.Box class="root" orientation={Gtk.Orientation.VERTICAL}>
        <Pill />
        <Card />
      </Gtk.Box>
    </Gtk.ApplicationWindow>
  );
}

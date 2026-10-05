// Fenêtre layer-shell en bas à gauche : une pastille qui s'ouvre en petite carte.
// Tout texte venant de Claude est affiché en texte brut (jamais de balisage Pango).

import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import Pango from "gi://Pango?version=1.0";
import { type Accessor, createComputed, createMemo, createState, For } from "gnim";
import type { SessionInfo } from "../../shared/protocol.ts";
import { acceptImageDrops } from "./attachments.ts";
import { Composer } from "./Composer.tsx";
import { activityText, STATUS_LABEL, usageText, usageTooltip } from "./format.ts";
import { claimKeyboardOnClick, releaseKeyboard, releaseKeyboardWhenDone } from "./keyboard.ts";
import { shortenPath } from "./paths.ts";
import { PermissionCard } from "./PermissionCard.tsx";
import { applyPlacement, corner, makeDraggable } from "./placement.ts";
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

const CARD_WIDTH = 380;
const CARD_HEIGHT = 480;
const TRANSITION_MS = 180;

/**
 * La carte a été ouverte (ou touchée) par l'utilisateur : un clic à l'extérieur la
 * referme. Pas quand elle s'ouvre seule pour une autorisation, pour ne pas avaler le
 * prochain clic de quelqu'un qui travaille ailleurs.
 */
const [engaged, setEngaged] = createState(false);

function open(): void {
  setEngaged(true);
  setExpanded(true);
}

function close(): void {
  setEngaged(false);
  setExpanded(false);
}

const selectedSession = createComputed(() => {
  const id = selectedId();
  return sessions().find((s) => s.id === id);
});

function setupLayerShell(win: Gtk.Window): void {
  LayerShell.init_for_window(win);
  LayerShell.set_namespace(win, "noko");
  LayerShell.set_layer(win, LayerShell.Layer.TOP);
  applyPlacement(win);
  // Par défaut, jamais le clavier : seulement au clic dans un champ (voir keyboard.ts).
  LayerShell.set_keyboard_mode(win, LayerShell.KeyboardMode.NONE);
  releaseKeyboardWhenDone(win, close);
  expanded.subscribe(() => {
    if (!expanded.peek()) releaseKeyboard(win);
  });
}

/**
 * Couche transparente plein écran, sous la carte, tant que l'utilisateur s'en sert :
 * un clic dessus referme la carte (comme un menu). La carte passe alors au calque
 * OVERLAY pour rester au-dessus de cette couche.
 */
function setupClickCatcher(app: Gtk.Application, widget: Gtk.Window): void {
  const catcher = new Gtk.Window({ application: app, title: "noko", cssClasses: ["noko-catcher"] });
  LayerShell.init_for_window(catcher);
  LayerShell.set_namespace(catcher, "noko-catcher");
  LayerShell.set_layer(catcher, LayerShell.Layer.TOP);
  for (const edge of [LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM, LayerShell.Edge.LEFT, LayerShell.Edge.RIGHT]) {
    LayerShell.set_anchor(catcher, edge, true);
  }
  LayerShell.set_exclusive_zone(catcher, -1);
  LayerShell.set_keyboard_mode(catcher, LayerShell.KeyboardMode.NONE);
  const click = new Gtk.GestureClick();
  click.connect("pressed", close);
  catcher.add_controller(click);

  const active = createComputed(() => expanded() && engaged());
  active.subscribe(() => {
    if (active.peek()) {
      const monitor = LayerShell.get_monitor(widget);
      if (monitor !== null) LayerShell.set_monitor(catcher, monitor);
      LayerShell.set_layer(widget, LayerShell.Layer.OVERLAY);
      catcher.present();
    } else {
      catcher.hide();
      LayerShell.set_layer(widget, LayerShell.Layer.TOP);
    }
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

/** Message sélectionnable : clic (clavier pris pour Ctrl+C) ou clic droit → Copier. */
function Message({ entry }: { entry: Entry }) {
  return (
    <Gtk.Label
      class={`message ${entry.role}`}
      label={entry.role === "tool" ? `▸ ${entry.text}` : entry.text}
      useMarkup={false}
      selectable
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
      $={claimKeyboardOnClick}
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
      $={(self) => {
        // Toucher la carte, c'est s'en servir : un clic à l'extérieur la refermera.
        const click = new Gtk.GestureClick();
        click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        click.connect("pressed", () => setEngaged(true));
        self.add_controller(click);
        acceptImageDrops(self);
      }}
    >
      <Gtk.Box class="header" spacing={6}>
        <SessionPicker />
        <Gtk.Button
          class="icon"
          label={composing((c) => (c ? "×" : "+"))}
          tooltipText="Nouvelle session"
          onClicked={() => setComposing(!composing.peek())}
        />
        <Gtk.Button class="icon" label="–" tooltipText="Réduire" onClicked={close} />
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

/** Pastille : état d'ensemble en un coup d'œil ; un clic ouvre la carte, glisser la déplace. */
function Pill({ halign }: { halign: Accessor<Gtk.Align> }) {
  const state = createComputed(() => {
    if (connection() !== "connected") return { cls: "offline", text: "daemon absent" };
    const pending = permissions().length;
    if (pending > 0) return { cls: "permission", text: pending > 1 ? `${pending} autorisations` : "autorisation requise" };
    const busy = sessions().find((s) => s.status === "running" || s.status === "starting");
    if (busy !== undefined) return { cls: "busy", text: activityText(busy) || "travaille…" };
    return { cls: "ready", text: "prêt" };
  });
  return (
    <Gtk.Box
      class={state((s) => `pill ${s.cls}`)}
      spacing={8}
      halign={halign}
      tooltipText="Cliquer pour ouvrir, glisser pour déplacer"
      $={(self) => makeDraggable(self, open)}
    >
      <Gtk.Label class="dot" label="●" />
      <Gtk.Label class="name" label="noko" />
      <Gtk.Label class="state" label={state((s) => s.text)} useMarkup={false} />
    </Gtk.Box>
  );
}

export function Widget({ app }: { app: Gtk.Application }) {
  let window: Gtk.Window;
  let root: Gtk.Box;
  let pill: Gtk.Revealer;
  let card: Gtk.Revealer;

  // La carte s'ouvre vers le centre de l'écran : au-dessus de la pastille si elle est
  // accrochée en bas, en dessous sinon ; la pastille reste collée au bord d'accroche.
  const slide = corner((c) =>
    c.vertical === "bottom" ? Gtk.RevealerTransitionType.SLIDE_UP : Gtk.RevealerTransitionType.SLIDE_DOWN,
  );
  const halign = corner((c) => (c.horizontal === "left" ? Gtk.Align.START : Gtk.Align.END));
  const order = () => {
    if (corner.peek().vertical === "bottom") root.reorder_child_after(pill, card);
    else root.reorder_child_after(card, pill);
  };

  // Un revealer replié garde la largeur de son contenu (seule la hauteur s'anime) :
  // on le masque à la fin de l'animation, sinon la pastille s'étire sur 380 px.
  const toggle = () => {
    const open = expanded.peek();
    const showing = open ? card : pill;
    const hiding = open ? pill : card;
    showing.visible = true;
    showing.revealChild = true;
    hiding.revealChild = false;
  };
  const hideWhenFolded = (self: Gtk.Revealer) => {
    self.connect("notify::child-revealed", () => {
      if (self.childRevealed || self.revealChild) return;
      self.visible = false;
      window.set_default_size(1, 1);
    });
  };

  return (
    <Gtk.ApplicationWindow
      application={app}
      title="noko"
      class="noko-widget"
      $={(win) => {
        window = win;
        setupLayerShell(win);
        setupClickCatcher(app, win);
        order();
        corner.subscribe(order);
        toggle();
        expanded.subscribe(toggle);
        win.present();
      }}
    >
      <Gtk.Box class="root" orientation={Gtk.Orientation.VERTICAL} $={(self) => (root = self)}>
        <Gtk.Revealer
          visible={false}
          transitionType={slide}
          transitionDuration={TRANSITION_MS}
          halign={halign}
          $={(self) => {
            card = self;
            hideWhenFolded(self);
          }}
        >
          <Card />
        </Gtk.Revealer>
        <Gtk.Revealer
          transitionType={Gtk.RevealerTransitionType.CROSSFADE}
          transitionDuration={TRANSITION_MS}
          halign={halign}
          $={(self) => {
            pill = self;
            hideWhenFolded(self);
          }}
        >
          <Pill halign={halign} />
        </Gtk.Revealer>
      </Gtk.Box>
    </Gtk.ApplicationWindow>
  );
}

// Fenêtre layer-shell en bas à gauche : une pastille qui s'ouvre en petite carte.
// Tout texte venant de Claude est affiché en texte brut (jamais de balisage Pango).

import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import Pango from "gi://Pango?version=1.0";
import cairo from "cairo";
import { createComputed, createMemo, createState, For } from "gnim";
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

function Card({ onCreated }: { onCreated: (card: Gtk.Box) => void }) {
  const usage = selectedSession((s) => s?.usage ?? null);
  return (
    <Gtk.Box
      class="card closed"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={8}
      widthRequest={CARD_WIDTH}
      heightRequest={CARD_HEIGHT}
      $={(self) => {
        onCreated(self);
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
function Pill({ onCreated }: { onCreated: (pill: Gtk.Box) => void }) {
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
      tooltipText="Cliquer pour ouvrir, glisser pour déplacer"
      $={(self) => {
        onCreated(self);
        makeDraggable(self, open);
      }}
    >
      <Gtk.Label class="dot" label="●" />
      <Gtk.Label class="name" label="noko" />
      <Gtk.Label class="state" label={state((s) => s.text)} useMarkup={false} />
    </Gtk.Box>
  );
}

/** Classe CSS du coin d'accroche : point d'origine et sens des animations. */
function cornerClass(): string {
  const c = corner.peek();
  return `from-${c.vertical}-${c.horizontal}`;
}

/**
 * Seule la partie visible capte la souris (pastille, ou carte ouverte) : le reste de la
 * fenêtre, transparent, laisse passer les clics vers les fenêtres en dessous.
 */
function trackInputRegion(win: Gtk.Window, card: Gtk.Widget, pill: Gtk.Widget): void {
  let last = "";
  win.add_tick_callback(() => {
    const surface = win.get_surface();
    const target = expanded.peek() ? card : pill;
    const [ok, bounds] = target.compute_bounds(win);
    if (surface === null || !ok) return true;
    const rect = {
      x: Math.floor(bounds.get_x()),
      y: Math.floor(bounds.get_y()),
      width: Math.ceil(bounds.get_width()),
      height: Math.ceil(bounds.get_height()),
    };
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (key !== last) {
      last = key;
      const region = new cairo.Region();
      region.unionRectangle(rect);
      surface.set_input_region(region);
    }
    return true;
  });
}

/**
 * Ouverture et fermeture animées en CSS, opacité et transformation seulement (voir
 * style.css). La fenêtre ne change jamais de taille : la carte se replie vers la
 * pastille, immobile dans son coin, qui réapparaît à la fin ; l'ouverture fait l'inverse.
 */
function animateToggle(card: Gtk.Box, pill: Gtk.Box): void {
  const setCorner = () => {
    for (const w of [card, pill]) {
      for (const cls of w.get_css_classes()) if (cls.startsWith("from-")) w.remove_css_class(cls);
      w.add_css_class(cornerClass());
    }
  };
  const apply = () => {
    const open = expanded.peek();
    card.canTarget = open;
    pill.canTarget = !open;
    if (open) {
      pill.add_css_class("hidden");
      card.remove_css_class("closed");
    } else {
      card.add_css_class("closed");
      pill.remove_css_class("hidden");
    }
  };
  setCorner();
  corner.subscribe(setCorner);
  apply();
  expanded.subscribe(apply);
}

export function Widget({ app }: { app: Gtk.Application }) {
  let card: Gtk.Box;
  let pill: Gtk.Box;
  let pillHolder: Gtk.Box;
  // La pastille et la carte partagent le coin d'accroche : la carte « éclot » de la pastille.
  const halign = corner((c) => (c.horizontal === "left" ? Gtk.Align.START : Gtk.Align.END));
  const valign = corner((c) => (c.vertical === "top" ? Gtk.Align.START : Gtk.Align.END));

  return (
    <Gtk.ApplicationWindow
      application={app}
      title="noko"
      class="noko-widget"
      $={(win) => {
        setupLayerShell(win);
        setupClickCatcher(app, win);
        animateToggle(card, pill);
        trackInputRegion(win, card, pill);
        win.present();
      }}
    >
      <Gtk.Overlay
        class="root"
        $={(self) => {
          // La pastille compte dans la taille : fenêtre à sa taille quand la carte est cachée.
          self.set_measure_overlay(pillHolder, true);
        }}
      >
        <Card onCreated={(c) => (card = c)} />
        <Gtk.Box $type="overlay" halign={halign} valign={valign} $={(self) => (pillHolder = self)}>
          <Pill onCreated={(p) => (pill = p)} />
        </Gtk.Box>
      </Gtk.Overlay>
    </Gtk.ApplicationWindow>
  );
}

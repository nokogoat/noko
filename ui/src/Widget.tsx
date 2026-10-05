// Fenêtre layer-shell en bas à gauche : une pastille qui s'ouvre en petite carte.
// Tout texte venant de Claude est affiché en texte brut (jamais de balisage Pango).

import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import Pango from "gi://Pango?version=1.0";
import cairo from "cairo";
import { createComputed, createMemo, createState, For } from "gnim";
import type { FileDiff, SessionInfo } from "../../shared/protocol.ts";
import { acceptImageDrops } from "./attachments.ts";
import { Composer } from "./Composer.tsx";
import { DiffView, diffStats } from "./DiffView.tsx";
import { labelFactory } from "./dropdown.ts";
import { activityText, STATUS_LABEL, usageText, usageTooltip } from "./format.ts";
import { claimKeyboardOnClick, releaseKeyboard, releaseKeyboardWhenDone } from "./keyboard.ts";
import { shortenPath } from "./paths.ts";
import { PermissionCard } from "./PermissionCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { applyPlacement, corner, makeDraggable } from "./placement.ts";
import { config } from "./settings.ts";
import { setMotion, Spring, type SpringConfig } from "./spring.ts";
import {
  composing,
  connection,
  expanded,
  permissions,
  questions,
  selectedId,
  sessions,
  setComposing,
  setExpanded,
  setSelectedId,
  transcripts,
  type Entry,
} from "./store.ts";

/** Taille de la carte ouverte (config.toml, section [panel]). */
const cardWidth = config((c) => c.panel.width);
const cardHeight = config((c) => c.panel.height);

/**
 * La carte a été ouverte (ou touchée) par l'utilisateur : un clic à l'extérieur la
 * referme. Pas quand elle s'ouvre seule pour une autorisation, pour ne pas avaler le
 * prochain clic de quelqu'un qui travaille ailleurs.
 */
const [engaged, setEngaged] = createState(false);

export function open(): void {
  setEngaged(true);
  setExpanded(true);
}

export function close(): void {
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

  const active = createComputed(() => expanded() && engaged() && config().behavior.close_on_click_outside);
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
  const where = s.source === "terminal" ? "  ·  terminal" : "";
  return `${shortenPath(s.cwd)}  ›  ${s.name}  ·  ${STATUS_LABEL[s.status]}${where}`;
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
      factory={labelFactory(Pango.EllipsizeMode.MIDDLE)}
      listFactory={labelFactory(Pango.EllipsizeMode.NONE)}
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

/** Appel d'outil qui modifie un fichier : résumé, et l'avant/après au clic. */
function ToolDiff({ entry, diff }: { entry: Entry; diff: FileDiff }) {
  return (
    <Gtk.Expander class="message tool">
      {/* Libellé à soi : celui de l'Expander ne revient pas à la ligne et élargirait la carte. */}
      <Gtk.Label
        $type="label"
        label={`${entry.text}  ${diffStats(diff)}`}
        useMarkup={false}
        wrap
        wrapMode={Pango.WrapMode.WORD_CHAR}
        xalign={0}
      />
      <DiffView diff={diff} header={false} />
    </Gtk.Expander>
  );
}

/** Message sélectionnable : clic (clavier pris pour Ctrl+C) ou clic droit → Copier. */
function Message({ entry }: { entry: Entry }) {
  if (entry.diff !== undefined) return <ToolDiff entry={entry} diff={entry.diff} />;
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

/** Contenu de la carte (sans fond : c'est la forme qui le dessine). */
function Card({ onCreated }: { onCreated: (card: Gtk.Box) => void }) {
  const usage = selectedSession((s) => s?.usage ?? null);
  return (
    <Gtk.Box
      class="card"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={8}
      widthRequest={cardWidth}
      heightRequest={cardHeight}
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
        maxContentHeight={cardHeight((h) => Math.round((h * 3) / 5))}
        visible={createComputed(() => permissions().length + questions().length > 0)}
      >
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <For each={permissions}>{(request) => <PermissionCard request={request} />}</For>
          <For each={questions}>{(request) => <QuestionCard request={request} />}</For>
        </Gtk.Box>
      </Gtk.ScrolledWindow>
      <Conversation />
      <ActivityLine />
      <Composer />
    </Gtk.Box>
  );
}

/** État d'ensemble affiché par la pastille (et sa couleur de bordure). */
const pillState = createComputed(() => {
  if (connection() !== "connected") return { cls: "offline", text: "daemon absent" };
  const pending = permissions().length;
  if (pending > 0) return { cls: "permission", text: pending > 1 ? `${pending} autorisations` : "autorisation requise" };
  if (questions().length > 0) return { cls: "question", text: "question pour toi" };
  const busy = sessions().find((s) => s.status === "running" || s.status === "starting");
  if (busy !== undefined) return { cls: "busy", text: activityText(busy) || "travaille…" };
  return { cls: "ready", text: "prêt" };
});

/** Contenu de la pastille ; un clic ouvre la carte, glisser la déplace. */
function Pill({ onCreated }: { onCreated: (pill: Gtk.Box) => void }) {
  return (
    <Gtk.Box
      class={pillState((s) => `pill ${s.cls}`)}
      spacing={8}
      tooltipText="Cliquer pour ouvrir, glisser pour déplacer"
      $={(self) => {
        onCreated(self);
        makeDraggable(self, open);
      }}
    >
      <Gtk.Label class="dot" label="●" />
      <Gtk.Label class="name" label="noko" />
      <Gtk.Label class="state" label={pillState((s) => s.text)} useMarkup={false} />
    </Gtk.Box>
  );
}

// Ressorts : ouverture vive avec un soupçon de rebond, fermeture nette sans rebond.
const OPEN_SPRING: SpringConfig = { stiffness: 380, dampingRatio: 0.82 };
const CLOSE_SPRING: SpringConfig = { stiffness: 520, dampingRatio: 1 };

const smoothstep = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * La forme (fond arrondi) passe de la taille de la pastille à celle de la carte, et
 * découvre le contenu au lieu de le déformer. Seule une boîte vide change de taille :
 * le texte n'est jamais redimensionné. Les opacités suivent la progression de la forme.
 * La fenêtre, elle, ne change jamais de taille (voir placement.ts).
 */
function animateMorph(win: Gtk.Window, shell: Gtk.Widget, spacer: Gtk.Widget, card: Gtk.Box, pill: Gtk.Box): void {
  const pillSize = () => {
    const [, w] = pill.measure(Gtk.Orientation.HORIZONTAL, -1);
    const [, h] = pill.measure(Gtk.Orientation.VERTICAL, -1);
    return { w, h };
  };
  const target = () => (expanded.peek() ? { w: cardWidth.peek(), h: cardHeight.peek() } : pillSize());
  const initial = target();
  const width = new Spring(initial.w, CLOSE_SPRING);
  const height = new Spring(initial.h, CLOSE_SPRING);

  /** Seule la partie visible capte la souris ; le reste laisse passer les clics. */
  const updateInputRegion = () => {
    const surface = win.get_surface();
    const [ok, bounds] = (expanded.peek() ? card : pill).compute_bounds(win);
    if (surface === null || !ok) return;
    const region = new cairo.Region();
    region.unionRectangle({
      x: Math.floor(bounds.get_x()),
      y: Math.floor(bounds.get_y()),
      width: Math.ceil(bounds.get_width()),
      height: Math.ceil(bounds.get_height()),
    });
    surface.set_input_region(region);
  };

  const render = () => {
    spacer.set_size_request(Math.round(width.value), Math.round(height.value));
    // Progression 0 (pastille) → 1 (carte), d'après la hauteur de la forme.
    const pill0 = pillSize().h;
    const progress = (height.value - pill0) / Math.max(1, cardHeight.peek() - pill0);
    card.opacity = smoothstep((progress - 0.45) / 0.5);
    pill.opacity = 1 - smoothstep(progress / 0.2);
  };

  // Le rappel d'image n'existe que pendant une animation : au repos, GTK ne redessine rien.
  let tick = 0;
  let last = 0;
  const run = () => {
    if (tick !== 0) return;
    last = 0;
    tick = shell.add_tick_callback((_w, clock) => {
      const now = clock.get_frame_time() / 1e6;
      const dt = last === 0 ? 1 / 60 : now - last;
      last = now;
      width.step(dt);
      height.step(dt);
      render();
      if (width.settled() && height.settled()) {
        tick = 0;
        updateInputRegion();
        return false;
      }
      return true;
    });
  };

  const retarget = () => {
    const open = expanded.peek();
    const t = target();
    const config = open ? OPEN_SPRING : CLOSE_SPRING;
    width.setTarget(t.w, config);
    height.setTarget(t.h, config);
    card.canTarget = open;
    pill.canTarget = !open;
    updateInputRegion();
    run();
  };

  card.canTarget = expanded.peek();
  pill.canTarget = !expanded.peek();
  setMotion(config.peek().animation.speed, config.peek().animation.enabled);
  render();
  expanded.subscribe(retarget);
  // Taille de la carte modifiée dans la config : la forme suit.
  config.subscribe(() => {
    const { animation } = config.peek();
    setMotion(animation.speed, animation.enabled);
    retarget();
  });
  // Texte de la pastille modifié : la forme suit sa nouvelle largeur, en douceur.
  pillState.subscribe(() => {
    if (!expanded.peek()) retarget();
  });
  // Coin d'accroche modifié (déplacement) : la zone cliquable suit, une fois placée.
  corner.subscribe(() => shell.add_tick_callback(() => (updateInputRegion(), false)));
  // Première zone cliquable, une fois la fenêtre affichée.
  win.connect("map", () => shell.add_tick_callback(() => (updateInputRegion(), false)));
}

export function Widget({ app }: { app: Gtk.Application }) {
  let shell: Gtk.Overlay;
  let spacer: Gtk.Box;
  let card: Gtk.Box;
  let pill: Gtk.Box;
  // Tout part du coin d'accroche : la forme y reste collée et grandit vers le centre.
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
        animateMorph(win, shell, spacer, card, pill);
        win.present();
      }}
    >
      <Gtk.Overlay class="root">
        {/* Taille fixe de la fenêtre : celle de la carte ouverte. */}
        <Gtk.Box class="sizer" widthRequest={cardWidth} heightRequest={cardHeight} />
        <Gtk.Overlay
          $type="overlay"
          class={pillState((s) => `shell ${s.cls}`)}
          halign={halign}
          valign={valign}
          overflow={Gtk.Overflow.HIDDEN}
          $={(self) => (shell = self)}
        >
          {/* Boîte vide dont la taille, animée, fixe celle de la forme. */}
          <Gtk.Box $={(self) => (spacer = self)} />
          <Gtk.Box $type="overlay" halign={halign} valign={valign}>
            <Card onCreated={(c) => (card = c)} />
          </Gtk.Box>
          <Gtk.Box $type="overlay" halign={halign} valign={valign}>
            <Pill onCreated={(p) => (pill = p)} />
          </Gtk.Box>
        </Gtk.Overlay>
      </Gtk.Overlay>
    </Gtk.ApplicationWindow>
  );
}

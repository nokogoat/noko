// Position du widget : accroché à un coin de l'écran, déplaçable à la souris.
// La fenêtre garde toujours la même taille (redimensionner une surface layer-shell fait
// sauter son contenu d'une image) : seuls ses marges et son coin d'accroche changent.
// Le coin d'accroche décide du sens d'ouverture de la carte (vers le centre de l'écran).

import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import GLib from "gi://GLib?version=2.0";
import { createState } from "gnim";
import { z } from "zod";
import { CARD_SIZE, type CornerName } from "../../shared/config.ts";
import { cardSize, clampSize, saveCardSize, setCardSize, setResizeRoom, type Size } from "./card-size.ts";
import { readText, STATE_DIR, writeText } from "./files.ts";
import { cursorPosition, hyprlandAvailable } from "./hyprland.ts";
import { config } from "./settings.ts";

export interface Corner {
  vertical: "top" | "bottom";
  horizontal: "left" | "right";
}

/** Marge de la forme dans la fenêtre (`.shell` et `.sizer` dans style.css), de chaque côté. */
const SHELL_MARGIN = 6;
/** En deçà (en pixels), un glissement est un simple clic. */
const DRAG_THRESHOLD = 4;
/** Dernière position choisie à la souris (prime sur celle de la config). */
const STATE_FILE = GLib.build_filenamev([STATE_DIR, "position.json"]);

const SavedPosition = z.object({
  corner: z.enum(["bottom-left", "bottom-right", "top-left", "top-right"]),
  x: z.number().int().min(0).max(10000),
  y: z.number().int().min(0).max(10000),
});

function toCorner(name: CornerName): Corner {
  const [vertical, horizontal] = name.split("-") as [Corner["vertical"], Corner["horizontal"]];
  return { vertical, horizontal };
}

function cornerName(c: Corner): CornerName {
  return `${c.vertical}-${c.horizontal}`;
}

function savedPosition(): z.infer<typeof SavedPosition> | null {
  const text = readText(STATE_FILE);
  if (text === null) return null;
  try {
    const parsed = SavedPosition.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function savePosition(c: Corner, x: number, y: number): void {
  writeText(STATE_FILE, JSON.stringify({ corner: cornerName(c), x, y }) + "\n");
}

export const [corner, setCorner] = createState<Corner>({ vertical: "bottom", horizontal: "left" });
/**
 * Glissement ou redimensionnement en cours : la forme bouge dans la fenêtre, alors toute
 * la fenêtre capte la souris (voir Widget.tsx), pour que le pointeur n'en sorte jamais.
 */
export const [interacting, setInteracting] = createState(false);
/** Distance de la fenêtre aux deux bords d'accroche. */
let margins = { x: 6, y: 6 };

const { Edge } = LayerShell;

function setAnchors(win: Gtk.Window, c: Corner, x: number, y: number): void {
  LayerShell.set_anchor(win, Edge.TOP, c.vertical === "top");
  LayerShell.set_anchor(win, Edge.BOTTOM, c.vertical === "bottom");
  LayerShell.set_anchor(win, Edge.LEFT, c.horizontal === "left");
  LayerShell.set_anchor(win, Edge.RIGHT, c.horizontal === "right");
  LayerShell.set_margin(win, Edge.TOP, c.vertical === "top" ? y : 0);
  LayerShell.set_margin(win, Edge.BOTTOM, c.vertical === "bottom" ? y : 0);
  LayerShell.set_margin(win, Edge.LEFT, c.horizontal === "left" ? x : 0);
  LayerShell.set_margin(win, Edge.RIGHT, c.horizontal === "right" ? x : 0);
  // L'état layer-shell n'est envoyé au compositeur qu'avec un nouveau dessin : sans lui,
  // au repos (aucune animation en cours), la fenêtre ne bougerait pas.
  win.queue_draw();
}

/** Place la fenêtre : dernière position mémorisée, sinon celle de la config. */
export function applyPlacement(win: Gtk.Window): void {
  const saved = savedPosition();
  const panel = config.peek().panel;
  margins = saved !== null ? { x: saved.x, y: saved.y } : { x: panel.margin_x, y: panel.margin_y };
  setCorner(toCorner(saved !== null ? saved.corner : panel.corner));
  // -1 : marges mesurées depuis le bord de l'écran, sans tenir compte des barres.
  LayerShell.set_exclusive_zone(win, -1);
  setAnchors(win, corner.peek(), margins.x, margins.y);

  // Position modifiée dans config.toml : elle s'applique et remplace celle mémorisée.
  let previous = config.peek().panel;
  config.subscribe(() => {
    const panel = config.peek().panel;
    const moved =
      panel.corner !== previous.corner || panel.margin_x !== previous.margin_x || panel.margin_y !== previous.margin_y;
    previous = panel;
    if (!moved) return;
    margins = { x: panel.margin_x, y: panel.margin_y };
    const next = toCorner(panel.corner);
    setCorner(next);
    setAnchors(win, next, margins.x, margins.y);
    savePosition(next, margins.x, margins.y);
  });
}

function monitorGeometry(win: Gtk.Window): Gdk.Rectangle | null {
  const surface = win.get_surface();
  const display = Gdk.Display.get_default();
  if (surface === null || display === null) return null;
  return display.get_monitor_at_surface(surface)?.get_geometry() ?? null;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/**
 * Rend la fenêtre de `handle` déplaçable en le glissant. Un clic sans glissement appelle
 * `onClick`. Pendant le glissement, la fenêtre s'accroche en direct au coin de l'écran le
 * plus proche de `handle`, qui reste ainsi dans le coin correspondant de la fenêtre.
 */
export function makeDraggable(handle: Gtk.Widget, onClick: () => void): void {
  const drag = new Gtk.GestureDrag();
  let win: Gtk.Window | null = null;
  let geom: Gdk.Rectangle | null = null;
  /** Taille de la fenêtre et de la poignée, et retrait de la poignée dans son coin. */
  let size = { w: 0, h: 0 };
  let handleSize = { w: 0, h: 0 };
  let inset = { x: 0, y: 0 };
  /** Position de la poignée à l'écran au début, et point saisi dans la poignée. */
  let start = { x: 0, y: 0 };
  let grab = { x: 0, y: 0 };
  let dragging = false;
  let moved = false;
  let inFlight = false;
  let stale = false;

  /** Place la poignée à (x, y) à l'écran, en choisissant le coin le plus proche. */
  const placeHandle = (x: number, y: number) => {
    if (win === null || geom === null) return;
    const hx = clamp(x, inset.x, geom.width - handleSize.w - inset.x);
    const hy = clamp(y, inset.y, geom.height - handleSize.h - inset.y);
    const next: Corner = {
      vertical: hy + handleSize.h / 2 < geom.height / 2 ? "top" : "bottom",
      horizontal: hx + handleSize.w / 2 < geom.width / 2 ? "left" : "right",
    };
    margins = {
      x: Math.round(next.horizontal === "left" ? hx - inset.x : geom.width - (hx + handleSize.w) - inset.x),
      y: Math.round(next.vertical === "top" ? hy - inset.y : geom.height - (hy + handleSize.h) - inset.y),
    };
    const current = corner.peek();
    if (current.vertical !== next.vertical || current.horizontal !== next.horizontal) setCorner(next);
    setAnchors(win, next, margins.x, margins.y);
  };

  // Une seule requête à la fois ; si le curseur a bougé entre-temps, on relance.
  const followCursor = () => {
    if (inFlight) {
      stale = true;
      return;
    }
    inFlight = true;
    cursorPosition((cursor) => {
      inFlight = false;
      if (!dragging || geom === null) return;
      if (cursor !== null) placeHandle(cursor.x - geom.x - grab.x, cursor.y - geom.y - grab.y);
      if (stale) {
        stale = false;
        followCursor();
      }
    });
  };

  drag.connect("drag-begin", (_g, x, y) => {
    const root = handle.get_root();
    win = root instanceof Gtk.Window ? root : null;
    geom = win === null ? null : monitorGeometry(win);
    if (win === null || geom === null) return;
    const [ok, bounds] = handle.compute_bounds(win);
    if (!ok) return;
    size = { w: win.get_width(), h: win.get_height() };
    handleSize = { w: bounds.get_width(), h: bounds.get_height() };
    const c = corner.peek();
    inset = {
      x: c.horizontal === "left" ? bounds.get_x() : size.w - bounds.get_x() - handleSize.w,
      y: c.vertical === "top" ? bounds.get_y() : size.h - bounds.get_y() - handleSize.h,
    };
    const winLeft = c.horizontal === "left" ? margins.x : geom.width - margins.x - size.w;
    const winTop = c.vertical === "top" ? margins.y : geom.height - margins.y - size.h;
    start = { x: winLeft + bounds.get_x(), y: winTop + bounds.get_y() };
    grab = { x, y };
    dragging = true;
    moved = false;
  });

  drag.connect("drag-update", (_g, dx, dy) => {
    if (!dragging) return;
    if (!moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      setInteracting(true);
    }
    // Sans Hyprland, la poignée ne bouge qu'au lâcher (décalage exact, fenêtre immobile).
    if (hyprlandAvailable()) followCursor();
  });

  drag.connect("drag-end", (_g, dx, dy) => {
    dragging = false;
    if (!moved) {
      onClick();
      return;
    }
    if (!hyprlandAvailable()) placeHandle(start.x + dx, start.y + dy);
    setInteracting(false);
    savePosition(corner.peek(), margins.x, margins.y);
  });

  handle.add_controller(drag);
  handle.set_cursor(Gdk.Cursor.new_from_name("grab", null));
}

/**
 * Redimensionne la carte en glissant `handle` avec le bouton `button` (1 = gauche,
 * 3 = droit). Le coin d'accroche ne bouge pas : la carte grandit vers le centre de l'écran.
 * La taille est mémorisée au lâcher.
 *
 * Le geste ne commence qu'au-delà de quelques pixels : un simple clic appelle `onClick`
 * (position dans `handle`). Avec le bouton droit, le geste passe avant les widgets de la
 * carte, qui ne voient donc plus ce clic : `onClick` leur rend (menu contextuel).
 *
 * Pas de touche exigée (Super…) : sous Wayland, l'état des touches n'est envoyé qu'à la
 * fenêtre qui a le clavier, et le panneau ne le prend jamais de lui-même.
 *
 * Avec Hyprland, la carte suit le curseur (position lue dans sa socket) et la fenêtre prend
 * d'emblée toute la place disponible, pour ne pas changer de taille à chaque mouvement.
 * Sans Hyprland, la nouvelle taille s'applique au lâcher.
 */
export function makeResizable(
  handle: Gtk.Widget,
  button: number,
  onClick: ((x: number, y: number) => void) | null = null,
): void {
  const drag = new Gtk.GestureDrag();
  drag.set_button(button);
  if (button !== 1) drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  let geom: Gdk.Rectangle | null = null;
  let press = { x: 0, y: 0 };
  let start: Size = cardSize.peek();
  let room: Size | null = null;
  /** Curseur à l'écran au début du redimensionnement (Hyprland). */
  let origin: { x: number; y: number } | null = null;
  let pressed = false;
  let active = false;
  let live = false;
  let inFlight = false;
  let stale = false;

  /** Taille pour un déplacement (dx, dy) du curseur depuis le début du geste. */
  const sizeFor = (dx: number, dy: number): Size => {
    const c = corner.peek();
    return clampSize(
      { w: start.w + (c.horizontal === "left" ? dx : -dx), h: start.h + (c.vertical === "top" ? dy : -dy) },
      room,
    );
  };

  const followCursor = () => {
    if (inFlight) {
      stale = true;
      return;
    }
    inFlight = true;
    cursorPosition((cursor) => {
      inFlight = false;
      if (!active || cursor === null) return;
      if (origin === null) origin = cursor;
      else setCardSize(sizeFor(cursor.x - origin.x, cursor.y - origin.y));
      if (stale) {
        stale = false;
        followCursor();
      }
    });
  };

  /** Le glissement dépasse le seuil : le redimensionnement commence. */
  const begin = () => {
    if (geom === null) return;
    start = cardSize.peek();
    // Place à l'écran : tout sauf la marge d'accroche et celles de la forme.
    room = { w: geom.width - margins.x - 2 * SHELL_MARGIN, h: geom.height - margins.y - 2 * SHELL_MARGIN };
    origin = null;
    active = true;
    live = hyprlandAvailable();
    setInteracting(true);
    if (live) {
      setResizeRoom(clampSize({ w: CARD_SIZE.width.max, h: CARD_SIZE.height.max }, room));
      followCursor();
    }
  };

  drag.connect("drag-begin", (_g, x, y) => {
    const root = handle.get_root();
    geom = root instanceof Gtk.Window ? monitorGeometry(root) : null;
    if (geom === null) {
      drag.set_state(Gtk.EventSequenceState.DENIED);
      return;
    }
    drag.set_state(Gtk.EventSequenceState.CLAIMED);
    press = { x, y };
    pressed = true;
    active = false;
  });

  drag.connect("drag-update", (_g, dx, dy) => {
    if (!pressed) return;
    if (!active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      begin();
    }
    if (active && live) followCursor();
  });

  drag.connect("drag-end", (_g, dx, dy) => {
    if (!pressed) return;
    pressed = false;
    if (!active) {
      onClick?.(press.x, press.y);
      return;
    }
    active = false;
    if (!live) setCardSize(sizeFor(dx, dy));
    setResizeRoom(null);
    setInteracting(false);
    saveCardSize(cardSize.peek());
  });

  handle.add_controller(drag);
}

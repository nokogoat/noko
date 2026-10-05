// Position du widget : accroché à un coin de l'écran, déplaçable à la souris.
// La fenêtre garde toujours la même taille (redimensionner une surface layer-shell fait
// sauter son contenu d'une image) : seuls ses marges et son coin d'accroche changent.
// Le coin d'accroche décide du sens d'ouverture de la carte (vers le centre de l'écran).

import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";
import { createState } from "gnim";
import { cursorPosition, hyprlandAvailable } from "./hyprland.ts";

export interface Corner {
  vertical: "top" | "bottom";
  horizontal: "left" | "right";
}

const DEFAULT_MARGIN = 6;
/** En deçà (en pixels), un glissement est un simple clic. */
const DRAG_THRESHOLD = 4;

export const [corner, setCorner] = createState<Corner>({ vertical: "bottom", horizontal: "left" });
/** Distance de la fenêtre aux deux bords d'accroche. */
let margins = { x: DEFAULT_MARGIN, y: DEFAULT_MARGIN };

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

export function applyPlacement(win: Gtk.Window): void {
  // -1 : marges mesurées depuis le bord de l'écran, sans tenir compte des barres.
  LayerShell.set_exclusive_zone(win, -1);
  setAnchors(win, corner.peek(), margins.x, margins.y);
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
  });

  handle.add_controller(drag);
  handle.set_cursor(Gdk.Cursor.new_from_name("grab", null));
}

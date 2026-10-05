// Position du widget : accroché à un coin de l'écran, déplaçable à la souris.
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

const DEFAULT_MARGIN = 12;
/** En deçà (en pixels), un glissement est un simple clic. */
const DRAG_THRESHOLD = 4;

export const [corner, setCorner] = createState<Corner>({ vertical: "bottom", horizontal: "left" });
/** Distance aux deux bords d'accroche. */
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
 * `onClick`. Au lâcher, la fenêtre s'accroche au coin le plus proche.
 */
export function makeDraggable(handle: Gtk.Widget, onClick: () => void): void {
  const drag = new Gtk.GestureDrag();
  // Fenêtre résolue au moment du glissement : `handle` est créé avant d'y être inséré.
  let win: Gtk.Window | null = null;
  let geom: Gdk.Rectangle | null = null;
  let start = { left: 0, top: 0 };
  let grab = { x: 0, y: 0 };
  let pos = { left: 0, top: 0 };
  let size = { w: 0, h: 0 };
  let dragging = false;
  let moved = false;
  let inFlight = false;
  let stale = false;

  const moveTo = (left: number, top: number) => {
    if (geom === null || win === null) return;
    pos = {
      left: Math.round(clamp(left, 0, geom.width - size.w)),
      top: Math.round(clamp(top, 0, geom.height - size.h)),
    };
    LayerShell.set_margin(win, Edge.LEFT, pos.left);
    LayerShell.set_margin(win, Edge.TOP, pos.top);
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
      if (cursor !== null) moveTo(cursor.x - geom.x - grab.x, cursor.y - geom.y - grab.y);
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
    size = { w: win.get_width(), h: win.get_height() };
    const c = corner.peek();
    start = {
      left: c.horizontal === "left" ? margins.x : geom.width - margins.x - size.w,
      top: c.vertical === "top" ? margins.y : geom.height - margins.y - size.h,
    };
    pos = { ...start };
    grab = { x, y };
    dragging = true;
    moved = false;
  });

  drag.connect("drag-update", (_g, dx, dy) => {
    if (!dragging || geom === null || win === null) return;
    if (!moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      // Pendant le glissement : accroche en haut à gauche, position absolue.
      setAnchors(win, { vertical: "top", horizontal: "left" }, start.left, start.top);
    }
    // Sans Hyprland, la fenêtre ne bouge qu'au lâcher (décalage exact, surface immobile).
    if (hyprlandAvailable()) followCursor();
  });

  drag.connect("drag-end", (_g, dx, dy) => {
    dragging = false;
    if (!moved || geom === null || win === null) {
      onClick();
      return;
    }
    if (!hyprlandAvailable()) moveTo(start.left + dx, start.top + dy);
    const next: Corner = {
      vertical: pos.top + size.h / 2 < geom.height / 2 ? "top" : "bottom",
      horizontal: pos.left + size.w / 2 < geom.width / 2 ? "left" : "right",
    };
    margins = {
      x: next.horizontal === "left" ? pos.left : geom.width - pos.left - size.w,
      y: next.vertical === "top" ? pos.top : geom.height - pos.top - size.h,
    };
    setCorner(next);
    setAnchors(win, next, margins.x, margins.y);
  });

  handle.add_controller(drag);
  handle.set_cursor(Gdk.Cursor.new_from_name("grab", null));
}

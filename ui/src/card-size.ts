// Taille de la carte ouverte : celle de config.toml, ou la dernière choisie à la souris
// (~/.local/state/noko/size.json), qui prime sans réécrire config.toml. Une taille modifiée
// dans config.toml s'applique et remplace celle mémorisée (comme la position).

import GLib from "gi://GLib?version=2.0";
import { createState } from "gnim";
import { z } from "zod";
import { CARD_SIZE } from "../../shared/config.ts";
import { readText, STATE_DIR, writeText } from "./files.ts";
import { config } from "./settings.ts";

export interface Size {
  w: number;
  h: number;
}

const SIZE_FILE = GLib.build_filenamev([STATE_DIR, "size.json"]);

const SavedSize = z.object({
  width: z.number().int().min(CARD_SIZE.width.min).max(CARD_SIZE.width.max),
  height: z.number().int().min(CARD_SIZE.height.min).max(CARD_SIZE.height.max),
});

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(Math.round(v), min), Math.max(min, max));

/** Taille dans les bornes de la config, et au plus `room` (place disponible à l'écran). */
export function clampSize(size: Size, room: Size | null = null): Size {
  return {
    w: clamp(size.w, CARD_SIZE.width.min, Math.min(CARD_SIZE.width.max, room?.w ?? Infinity)),
    h: clamp(size.h, CARD_SIZE.height.min, Math.min(CARD_SIZE.height.max, room?.h ?? Infinity)),
  };
}

function savedSize(): Size | null {
  const text = readText(SIZE_FILE);
  if (text === null) return null;
  try {
    const parsed = SavedSize.safeParse(JSON.parse(text));
    return parsed.success ? { w: parsed.data.width, h: parsed.data.height } : null;
  } catch {
    return null;
  }
}

export function saveCardSize(size: Size): void {
  writeText(SIZE_FILE, JSON.stringify({ width: size.w, height: size.h }) + "\n");
}

export const [cardSize, setCardSize] = createState<Size>({ w: CARD_SIZE.width.default, h: CARD_SIZE.height.default });
export const cardWidth = cardSize((s) => s.w);
export const cardHeight = cardSize((s) => s.h);

/**
 * Taille de la fenêtre pendant un redimensionnement : la plus grande possible, pour que la
 * carte grandisse sans que la surface change de taille à chaque mouvement. null au repos
 * (la fenêtre a alors la taille de la carte).
 */
export const [resizeRoom, setResizeRoom] = createState<Size | null>(null);

/** Taille de départ ; à appeler une fois la config chargée. */
export function startCardSize(): void {
  const panel = config.peek().panel;
  setCardSize(savedSize() ?? { w: panel.width, h: panel.height });
  let previous = panel;
  config.subscribe(() => {
    const next = config.peek().panel;
    const changed = next.width !== previous.width || next.height !== previous.height;
    previous = next;
    if (!changed) return;
    const size = { w: next.width, h: next.height };
    setCardSize(size);
    saveCardSize(size);
  });
}

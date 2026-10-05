// Images jointes au prochain message : collées (Ctrl+V) ou glissées sur la carte.
// Réduites à la taille utile pour Claude, puis encodées en PNG base64.

import Gdk from "gi://Gdk?version=4.0";
import GdkPixbuf from "gi://GdkPixbuf?version=2.0";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import GObject from "gi://GObject?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { createState } from "gnim";
import { type ImageAttachment, MAX_IMAGE_BASE64, MAX_IMAGES } from "../../shared/protocol.ts";
import { t } from "./i18n.ts";

/** Au-delà, l'API réduit l'image de toute façon : inutile d'envoyer plus. */
const MAX_EDGE = 1568;
/** Taille brute maximale (le base64 ajoute un tiers). */
const MAX_RAW_BYTES = Math.floor((MAX_IMAGE_BASE64 / 4) * 3) - 1024;

export interface Attachment {
  id: number;
  image: ImageAttachment;
  thumbnail: Gdk.Texture;
}

export const [attachments, setAttachments] = createState<readonly Attachment[]>([]);
export const [attachmentError, setAttachmentError] = createState<string | null>(null);

let nextId = 1;

function scaled(pixbuf: GdkPixbuf.Pixbuf, maxEdge: number): GdkPixbuf.Pixbuf {
  const w = pixbuf.get_width();
  const h = pixbuf.get_height();
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return pixbuf;
  const k = maxEdge / longest;
  return (
    pixbuf.scale_simple(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), GdkPixbuf.InterpType.BILINEAR) ??
    pixbuf
  );
}

/** PNG sous la limite de taille, en réduisant encore si nécessaire. */
function encodePng(source: GdkPixbuf.Pixbuf): Uint8Array | null {
  let edge = MAX_EDGE;
  while (edge >= 256) {
    const [ok, buffer] = scaled(source, edge).save_to_bufferv("png", [], []);
    if (!ok) return null;
    if (buffer.length <= MAX_RAW_BYTES) return buffer;
    edge = Math.floor(edge * 0.75);
  }
  return null;
}

function addPixbuf(pixbuf: GdkPixbuf.Pixbuf): void {
  if (attachments.peek().length >= MAX_IMAGES) {
    setAttachmentError(t.peek().attachment.tooMany(MAX_IMAGES));
    return;
  }
  const png = encodePng(pixbuf);
  if (png === null) {
    setAttachmentError(t.peek().attachment.tooLarge);
    return;
  }
  const attachment: Attachment = {
    id: nextId++,
    image: { mediaType: "image/png", data: GLib.base64_encode(png) },
    thumbnail: Gdk.Texture.new_from_bytes(new GLib.Bytes(png)),
  };
  setAttachmentError(null);
  setAttachments([...attachments.peek(), attachment]);
}

export function addTexture(texture: Gdk.Texture): void {
  try {
    const stream = Gio.MemoryInputStream.new_from_bytes(texture.save_to_png_bytes());
    addPixbuf(GdkPixbuf.Pixbuf.new_from_stream(stream, null));
  } catch {
    setAttachmentError(t.peek().attachment.unreadable);
  }
}

export function addFile(file: Gio.File): void {
  const path = file.get_path();
  if (path === null) {
    setAttachmentError(t.peek().attachment.inaccessible);
    return;
  }
  try {
    addPixbuf(GdkPixbuf.Pixbuf.new_from_file(path));
  } catch {
    setAttachmentError(t.peek().attachment.notImage);
  }
}

export function removeAttachment(id: number): void {
  setAttachments(attachments.peek().filter((a) => a.id !== id));
}

/** Retire et renvoie les images à envoyer avec le message. */
export function takeAttachments(): ImageAttachment[] {
  const images = attachments.peek().map((a) => a.image);
  setAttachments([]);
  setAttachmentError(null);
  return images;
}

/**
 * Ctrl+V dans un champ : une image (capture, ou fichier image copié) est jointe ;
 * du texte est collé normalement.
 */
export function pasteImagesInto(entry: Gtk.Widget): void {
  const keys = new Gtk.EventControllerKey();
  keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  keys.connect("key-pressed", (_c, keyval, _code, state) => {
    const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
    if (!ctrl || (keyval !== Gdk.KEY_v && keyval !== Gdk.KEY_V)) return false;
    const clipboard = entry.get_clipboard();
    const formats = clipboard.get_formats();
    if (formats.contain_gtype(Gdk.Texture.$gtype)) {
      clipboard.read_texture_async(null, (_s, res) => {
        try {
          const texture = clipboard.read_texture_finish(res);
          if (texture !== null) addTexture(texture);
        } catch {
          setAttachmentError(t.peek().attachment.clipboardImage);
        }
      });
      return true;
    }
    if (formats.contain_gtype(Gdk.FileList.$gtype)) {
      clipboard.read_value_async(Gdk.FileList.$gtype, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        try {
          const list = clipboard.read_value_finish(res) as unknown as Gdk.FileList;
          for (const file of list.get_files()) addFile(file);
        } catch {
          setAttachmentError(t.peek().attachment.clipboardFiles);
        }
      });
      return true;
    }
    return false;
  });
  entry.add_controller(keys);
}

/** Glisser-déposer d'images (fichiers ou image directe) sur un widget. */
export function acceptImageDrops(widget: Gtk.Widget): void {
  const drop = Gtk.DropTarget.new(GObject.TYPE_NONE, Gdk.DragAction.COPY);
  drop.set_gtypes([Gdk.FileList.$gtype, Gdk.Texture.$gtype]);
  drop.connect("drop", (_t, value: unknown) => {
    if (value instanceof Gdk.Texture) {
      addTexture(value);
      return true;
    }
    if (value instanceof Gdk.FileList) {
      for (const file of value.get_files()) addFile(file);
      return true;
    }
    return false;
  });
  widget.add_controller(drop);
}

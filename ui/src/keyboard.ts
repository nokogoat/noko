// Le panneau ne prend le clavier que lorsqu'on clique dans un champ de saisie,
// et le rend dès qu'il perd le focus ou qu'on appuie sur Échap.

import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";

function setMode(win: Gtk.Window, mode: LayerShell.KeyboardMode): void {
  if (LayerShell.get_keyboard_mode(win) !== mode) LayerShell.set_keyboard_mode(win, mode);
}

/**
 * Au clic dans le champ : le panneau demande le clavier (mode « on-demand »). Un texte
 * sélectionnable prend le focus par son propre clic : le lui donner ici sélectionnerait tout
 * son contenu (comportement de GTK au focus), au lieu de ce qu'on surligne à la souris.
 */
export function claimKeyboardOnClick(entry: Gtk.Widget): void {
  const click = new Gtk.GestureClick();
  click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  click.connect("pressed", () => {
    const win = entry.get_root();
    if (!(win instanceof Gtk.Window)) return;
    setMode(win, LayerShell.KeyboardMode.ON_DEMAND);
    if (!(entry instanceof Gtk.Label)) entry.grab_focus();
  });
  entry.add_controller(click);
}

/** Rend le clavier immédiatement. */
export function releaseKeyboard(win: Gtk.Window): void {
  win.set_focus(null);
  setMode(win, LayerShell.KeyboardMode.NONE);
}

/** Rend le clavier quand la fenêtre perd le focus ou sur Échap (puis appelle `onEscape`). */
export function releaseKeyboardWhenDone(win: Gtk.Window, onEscape: () => void = () => {}): void {
  const release = () => releaseKeyboard(win);
  win.connect("notify::is-active", () => {
    if (!win.isActive) release();
  });
  const keys = new Gtk.EventControllerKey();
  keys.connect("key-pressed", (_ctrl, keyval) => {
    if (keyval !== Gdk.KEY_Escape) return false;
    release();
    onEscape();
    return true;
  });
  win.add_controller(keys);
}

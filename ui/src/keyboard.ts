// Le panneau ne prend le clavier que lorsqu'on clique dans un champ de saisie,
// et le rend dès qu'il perd le focus ou qu'on appuie sur Échap.

import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell?version=1.0";

function setMode(win: Gtk.Window, mode: LayerShell.KeyboardMode): void {
  if (LayerShell.get_keyboard_mode(win) !== mode) LayerShell.set_keyboard_mode(win, mode);
}

/** Au clic dans le champ : le panneau demande le clavier (mode « on-demand »). */
export function claimKeyboardOnClick(entry: Gtk.Widget): void {
  const click = new Gtk.GestureClick();
  click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  click.connect("pressed", () => {
    const win = entry.get_root();
    if (!(win instanceof Gtk.Window)) return;
    setMode(win, LayerShell.KeyboardMode.ON_DEMAND);
    entry.grab_focus();
  });
  entry.add_controller(click);
}

/** Rend le clavier quand la fenêtre perd le focus ou sur Échap. */
export function releaseKeyboardWhenDone(win: Gtk.Window): void {
  const release = () => {
    win.set_focus(null);
    setMode(win, LayerShell.KeyboardMode.NONE);
  };
  win.connect("notify::is-active", () => {
    if (!win.isActive) release();
  });
  const keys = new Gtk.EventControllerKey();
  keys.connect("key-pressed", (_ctrl, keyval) => {
    if (keyval !== Gdk.KEY_Escape) return false;
    release();
    return true;
  });
  win.add_controller(keys);
}

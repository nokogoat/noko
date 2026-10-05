// Point d'entrée de l'UI (GJS). Ne fait qu'afficher l'état du daemon : elle peut être
// relancée ou planter sans rien perdre.

import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { createRoot } from "gnim";
import { programArgs, programInvocationName } from "system";
import { client, loadSelectedHistory } from "./actions.ts";
import { startCardSize } from "./card-size.ts";
import { SHOW_SESSION_ACTION, withdrawAll } from "./notifications.ts";
import { startSettings } from "./settings.ts";
import { close, open, Widget } from "./Widget.tsx";
import { connection, expanded, selectedId, sessions, setSelectedId } from "./store.ts";
import css from "./style.css";

const APP_ID = "io.github.nokogoat.Noko";

function loadStyle(): void {
  const display = Gdk.Display.get_default();
  if (display === null) return;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(css);
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

const app = new Gtk.Application({
  applicationId: APP_ID,
  flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
});

let started = false;

app.connect("activate", () => {
  // Instance unique : une seconde activation ouvre la carte.
  if (started) {
    open();
    return;
  }
  started = true;
  loadStyle();
  startSettings();
  startCardSize();
  createRoot(() => Widget({ app }));
  // Historique de la session affichée, dès qu'elle est connue (sélection, connexion,
  // identifiant Claude reçu).
  selectedId.subscribe(loadSelectedHistory);
  sessions.subscribe(loadSelectedHistory);
  connection.subscribe(loadSelectedHistory);
  // Carte ouverte : les notifications en cours n'ont plus lieu d'être.
  expanded.subscribe(() => {
    if (expanded.peek()) withdrawAll();
  });
  client.start();
});

// Actions pour un raccourci clavier, par ex. dans hyprland.conf :
//   bind = SUPER, N, exec, gapplication action io.github.nokogoat.Noko toggle
const actions: Record<string, () => void> = {
  toggle: () => (expanded.peek() ? close() : open()),
  open,
  close,
};
for (const [name, run] of Object.entries(actions)) {
  const action = new Gio.SimpleAction({ name });
  action.connect("activate", run);
  app.add_action(action);
}

// Clic sur une notification : la carte s'ouvre sur la session concernée (si elle existe encore).
const showSession = new Gio.SimpleAction({ name: SHOW_SESSION_ACTION, parameterType: new GLib.VariantType("s") });
showSession.connect("activate", (_action, parameter) => {
  const id = parameter?.unpack() as unknown;
  if (typeof id === "string" && sessions.peek().some((s) => s.id === id)) setSelectedId(id);
  open();
});
app.add_action(showSession);

app.connect("shutdown", () => client.stop());

await app.runAsync([programInvocationName, ...programArgs]);

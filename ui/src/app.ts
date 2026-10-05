// Point d'entrée de l'UI (GJS). Ne fait qu'afficher l'état du daemon : elle peut être
// relancée ou planter sans rien perdre.

import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { createRoot } from "gnim";
import { programArgs, programInvocationName } from "system";
import { client, loadSelectedHistory } from "./actions.ts";
import { Widget } from "./Widget.tsx";
import { connection, selectedId, sessions, setExpanded } from "./store.ts";
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
    setExpanded(true);
    return;
  }
  started = true;
  loadStyle();
  createRoot(() => Widget({ app }));
  // Historique de la session affichée, dès qu'elle est connue (sélection, connexion,
  // identifiant Claude reçu).
  selectedId.subscribe(loadSelectedHistory);
  sessions.subscribe(loadSelectedHistory);
  connection.subscribe(loadSelectedHistory);
  client.start();
});

app.connect("shutdown", () => client.stop());

await app.runAsync([programInvocationName, ...programArgs]);

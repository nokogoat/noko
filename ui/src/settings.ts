// Config utilisateur et thème : chargés au démarrage, rechargés à chaque modification
// de ~/.config/noko (config.toml, themes/*.toml).

import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { createState } from "gnim";
import { type Config, DEFAULT_CONFIG, parseConfig, parseTheme, type Theme, themeCss } from "../../shared/config.ts";
import template from "../config.example.toml";
import aube from "../themes/aube.toml";
import braise from "../themes/braise.toml";
import foret from "../themes/foret.toml";
import nuit from "../themes/nuit.toml";
import { CONFIG_DIR, readText, writeText } from "./files.ts";
import { activeBorderColor } from "./hyprland.ts";

const BUILTIN_THEMES: Record<string, string> = { nuit, aube, foret, braise };
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, "config.toml"]);
const THEMES_DIR = GLib.build_filenamev([CONFIG_DIR, "themes"]);
/** Plusieurs écritures d'un éditeur se suivent : on attend qu'elles soient finies. */
const RELOAD_DELAY_MS = 150;

export const [config, setConfig] = createState<Config>(DEFAULT_CONFIG);
/** Problème de lecture de la config ou du thème, à afficher ; null si tout va bien. */
export const [settingsError, setSettingsError] = createState<string | null>(null);

const provider = new Gtk.CssProvider();

/** Thème demandé : fichier de l'utilisateur, sinon intégré, sinon « nuit ». */
function loadTheme(name: string): { theme: Theme; error: string | null } {
  const fallback = parseTheme(nuit).value!;
  const userText = readText(GLib.build_filenamev([THEMES_DIR, `${name}.toml`]));
  if (userText !== null) {
    const parsed = parseTheme(userText);
    if (parsed.value !== null) return { theme: parsed.value, error: null };
    return { theme: fallback, error: `thème « ${name} » ignoré (${parsed.error})` };
  }
  const builtin = BUILTIN_THEMES[name];
  if (builtin !== undefined) return { theme: parseTheme(builtin).value ?? fallback, error: null };
  return { theme: fallback, error: `thème « ${name} » introuvable` };
}

function applyTheme(theme: Theme, accent: string | null): void {
  provider.load_from_string(themeCss(theme, accent));
}

function reload(): void {
  let text = readText(CONFIG_FILE);
  if (text === null && !Gio.File.new_for_path(CONFIG_FILE).query_exists(null)) {
    // Premier lancement : un modèle commenté, pour découvrir les réglages.
    writeText(CONFIG_FILE, template);
    text = template;
  }
  const parsed = parseConfig(text ?? "");
  const { theme, error } = loadTheme(parsed.value.theme.name);
  setSettingsError(parsed.error !== null ? `config.toml ignoré : ${parsed.error}` : error);
  setConfig(parsed.value);

  applyTheme(theme, null);
  if (parsed.value.theme.follow_hyprland) {
    activeBorderColor((color) => {
      // Ignoré si la config a changé entre-temps.
      if (color !== null && config.peek() === parsed.value) applyTheme(theme, color);
    });
  }
}

let reloadSource = 0;
const scheduleReload = () => {
  if (reloadSource !== 0) GLib.source_remove(reloadSource);
  reloadSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DELAY_MS, () => {
    reloadSource = 0;
    reload();
    return GLib.SOURCE_REMOVE;
  });
};

// Gardés en vie tant que l'application tourne.
const monitors: Gio.FileMonitor[] = [];

function watch(path: string): void {
  try {
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null)) dir.make_directory_with_parents(null);
    const monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
    monitor.connect("changed", scheduleReload);
    monitors.push(monitor);
  } catch {
    // Pas de rechargement à chaud pour ce dossier.
  }
}

/** Charge la config et le thème, et surveille leurs fichiers. */
export function startSettings(): void {
  const display = Gdk.Display.get_default();
  // Priorité USER : le thème passe devant la feuille de style de base.
  if (display !== null) Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
  reload();
  watch(CONFIG_DIR);
  watch(THEMES_DIR);
}

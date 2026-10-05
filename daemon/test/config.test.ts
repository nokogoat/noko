import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, hyprlandColor, parseConfig, parseTheme, themeCss } from "../../shared/config.ts";

test("config vide ou absente : valeurs par défaut", () => {
  assert.deepEqual(parseConfig("").value, DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.panel.corner, "bottom-left");
  assert.equal(DEFAULT_CONFIG.theme.name, "nuit");
  assert.equal(DEFAULT_CONFIG.sounds.enabled, false);
});

test("TOML illisible : valeurs par défaut et erreur signalée", () => {
  const parsed = parseConfig("[panel\ncorner = ");
  assert.deepEqual(parsed.value, DEFAULT_CONFIG);
  assert.notEqual(parsed.error, null);
});

test("une valeur invalide est remplacée par sa valeur par défaut, champ par champ", () => {
  const { value, error } = parseConfig(`
[panel]
corner = "top-right"
width = 99999
height = "grand"

[theme]
name = "../../etc/passwd"

[animation]
speed = 2

[sounds]
enabled = true
done = "relatif.oga"
permission = "/usr/share/sounds/bell.oga"
`);
  assert.equal(error, null);
  assert.equal(value.panel.corner, "top-right");
  assert.equal(value.panel.width, DEFAULT_CONFIG.panel.width);
  assert.equal(value.panel.height, DEFAULT_CONFIG.panel.height);
  assert.equal(value.theme.name, "nuit");
  assert.equal(value.animation.speed, 2);
  assert.equal(value.sounds.done, "");
  assert.equal(value.sounds.permission, "/usr/share/sounds/bell.oga");
});

test("une section invalide entière retombe sur ses valeurs par défaut", () => {
  assert.deepEqual(parseConfig('panel = "oups"').value.panel, DEFAULT_CONFIG.panel);
});

const THEME = `
name = "Essai"
author = "quelqu'un"

[colors]
background = "rgba(10, 10, 10, 0.9)"
surface = "#ffffff10"
surface_hover = "#fff2"
foreground = "#eeeeee"
muted = "#888"
accent = "#c4a7e7"
ok = "#9ccfd8"
warn = "#f6c177"
error = "#eb6f92"
border = "rgba(255, 255, 255, 0.08)"
shadow = "rgba(0, 0, 0, 0.35)"

[shape]
radius = 12
`;

test("thème valide → CSS composé uniquement de variables", () => {
  const { value: theme, error } = parseTheme(THEME);
  assert.equal(error, null);
  assert.ok(theme);
  const css = themeCss(theme);
  assert.match(css, /--noko-bg: rgba\(10, 10, 10, 0\.9\);/);
  assert.match(css, /border-radius: 12px;/);
  assert.match(themeCss(theme, "rgba(1, 2, 3, 1)"), /--noko-accent: rgba\(1, 2, 3, 1\);/);
});

test("thème refusé en entier si une couleur n'est pas une couleur", () => {
  for (const evil of [
    'url("file:///etc/passwd")',
    "red; } window { background-image: url(x)",
    "var(--x)",
    "rgb(1,2,3) !important",
    "",
  ]) {
    const { value, error } = parseTheme(THEME.replace('"#c4a7e7"', JSON.stringify(evil)));
    assert.equal(value, null, evil);
    assert.match(error ?? "", /colors\.accent/);
  }
  assert.equal(parseTheme("pas = du [toml").value, null);
  assert.equal(parseTheme('name = "x"').value, null);
});

test("les thèmes intégrés sont tous valides", () => {
  const dir = join(import.meta.dirname, "..", "..", "ui", "themes");
  const files = readdirSync(dir).filter((f) => f.endsWith(".toml"));
  assert.ok(files.includes("nuit.toml"));
  for (const file of files) {
    const { value, error } = parseTheme(readFileSync(join(dir, file), "utf8"));
    assert.ok(value, `${file} : ${error}`);
  }
});

test("couleur Hyprland aarrggbb → rgba()", () => {
  assert.equal(hyprlandColor("ee33ccff"), "rgba(51, 204, 255, 0.93)");
  assert.equal(hyprlandColor("ff999999"), "rgba(153, 153, 153, 1)");
  assert.equal(hyprlandColor("zz"), null);
});

// Configuration utilisateur (config.toml) et thèmes (themes/*.toml).
// Entrées non fiables : tout est validé par zod. Une valeur invalide est remplacée par sa
// valeur par défaut, champ par champ ; un fichier illisible donne la config par défaut.
// Aucune commande n'est possible : les sons sont des chemins de fichiers.

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// --- Config ----------------------------------------------------------------

const Corner = z.enum(["bottom-left", "bottom-right", "top-left", "top-right"]);
export type CornerName = z.infer<typeof Corner>;

/** Chemin de son : absolu, sans caractère nul ; vide = pas de son. */
const SoundPath = z
  .string()
  .max(4096)
  .refine((p) => p === "" || (p.startsWith("/") && !p.includes("\0")), "chemin absolu attendu");

const int = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).catch(fallback);
const bool = (fallback: boolean) => z.boolean().catch(fallback);

/** Une section absente ou invalide donne ses valeurs par défaut. */
function section<T extends z.ZodRawShape>(shape: T) {
  const schema = z.object(shape);
  return schema.catch(() => schema.parse({}));
}

export const ConfigSchema = z.object({
  panel: section({
    /** Coin de départ ; la position choisie à la souris est ensuite mémorisée. */
    corner: Corner.catch("bottom-left"),
    margin_x: int(0, 4000, 6),
    margin_y: int(0, 4000, 6),
    width: int(280, 1200, 600),
    height: int(240, 1600, 380),
  }),
  theme: section({
    /** Thème intégré ou fichier ~/.config/noko/themes/<name>.toml. */
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).catch("nuit"),
    /** Reprendre la couleur des bordures de Hyprland comme couleur d'accent. */
    follow_hyprland: bool(false),
  }),
  animation: section({
    enabled: bool(true),
    /** 1 = normal ; 0.5 = deux fois plus lent ; 2 = deux fois plus rapide. */
    speed: z.number().min(0.25).max(4).catch(1),
  }),
  behavior: section({
    /** Ouvrir la carte quand Claude demande une autorisation ou pose une question. */
    open_on_request: bool(true),
    /** Replier la carte quand on clique en dehors. */
    close_on_click_outside: bool(true),
  }),
  sounds: section({
    enabled: bool(false),
    permission: SoundPath.catch(""),
    question: SoundPath.catch(""),
    done: SoundPath.catch(""),
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export interface Parsed<T> {
  value: T;
  /** Erreur de lecture du fichier (syntaxe TOML), sinon null. */
  error: string | null;
}

export function parseConfig(text: string): Parsed<Config> {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    return { value: DEFAULT_CONFIG, error: err instanceof Error ? err.message : "TOML invalide" };
  }
  const parsed = ConfigSchema.safeParse(raw);
  return parsed.success ? { value: parsed.data, error: null } : { value: DEFAULT_CONFIG, error: "config invalide" };
}

// --- Thèmes ----------------------------------------------------------------

/**
 * Couleur CSS restreinte : #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() numériques.
 * Rien d'autre (pas d'url(), de var(), de fonctions) : un thème ne fait que colorer.
 */
const COLOR_RE =
  /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
const Color = z.string().max(64).regex(COLOR_RE, "couleur invalide");

const ThemeColors = z.object({
  background: Color,
  surface: Color,
  surface_hover: Color,
  foreground: Color,
  muted: Color,
  accent: Color,
  ok: Color,
  warn: Color,
  error: Color,
  border: Color,
  shadow: Color,
});
export type ThemeColors = z.infer<typeof ThemeColors>;

export const ThemeSchema = z.object({
  name: z.string().min(1).max(64),
  author: z.string().max(128).default(""),
  colors: ThemeColors,
  shape: z
    .object({
      /** Rayon des coins de la carte et de la pastille, en pixels. */
      radius: z.number().int().min(0).max(32).default(17),
      /** Taille du texte, relative à celle du système (1 = identique). */
      font_scale: z.number().min(0.7).max(1.5).default(0.95),
    })
    .default({ radius: 17, font_scale: 0.95 }),
});
export type Theme = z.infer<typeof ThemeSchema>;

/** Thème validé, ou null avec la raison (un thème invalide n'est jamais appliqué à moitié). */
export function parseTheme(text: string): Parsed<Theme | null> {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : "TOML invalide" };
  }
  const parsed = ThemeSchema.safeParse(raw);
  if (parsed.success) return { value: parsed.data, error: null };
  const issue = parsed.error.issues[0];
  return { value: null, error: issue ? `${issue.path.join(".")} : ${issue.message}` : "thème invalide" };
}

const VARIABLES: Record<keyof ThemeColors, string> = {
  background: "--noko-bg",
  surface: "--noko-surface",
  surface_hover: "--noko-surface-hover",
  foreground: "--noko-fg",
  muted: "--noko-muted",
  accent: "--noko-accent",
  ok: "--noko-ok",
  warn: "--noko-warn",
  error: "--noko-error",
  border: "--noko-border",
  shadow: "--noko-shadow",
};

/** CSS du thème : uniquement des variables, construites à partir de valeurs validées. */
export function themeCss(theme: Theme, accentOverride: string | null = null): string {
  const lines: string[] = [];
  for (const [key, variable] of Object.entries(VARIABLES) as [keyof ThemeColors, string][]) {
    const value = key === "accent" && accentOverride !== null ? accentOverride : theme.colors[key];
    // Revalidé ici : themeCss ne doit jamais recevoir autre chose qu'une couleur.
    if (!COLOR_RE.test(value)) continue;
    lines.push(`  ${variable}: ${value};`);
  }
  lines.push(`  --noko-radius: ${theme.shape.radius}px;`);
  return [
    "window.noko-widget {",
    ...lines,
    `  font-size: ${theme.shape.font_scale}em;`,
    "}",
    `.shell { border-radius: ${theme.shape.radius}px; }`,
    "",
  ].join("\n");
}

/** Couleur Hyprland « aarrggbb » (ex. « ee33ccff ») → rgba() CSS, ou null. */
export function hyprlandColor(value: string): string | null {
  const m = /^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(value);
  if (m === null) return null;
  const [a, r, g, b] = m.slice(1).map((h) => parseInt(h, 16)) as [number, number, number, number];
  return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(2))})`;
}

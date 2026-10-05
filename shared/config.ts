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

/** Langues de l'interface ; « auto » suit la langue du système (anglais si non traduite). */
export const LANGUAGES = ["fr", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Taille de la carte ouverte, en pixels : bornes communes à la config et au redimensionnement. */
export const CARD_SIZE = {
  width: { min: 280, max: 1200, default: 600 },
  height: { min: 240, max: 1600, default: 380 },
} as const;

export const ConfigSchema = z.object({
  general: section({
    language: z.enum(["auto", ...LANGUAGES]).catch("auto"),
  }),
  panel: section({
    /** Coin de départ ; la position choisie à la souris est ensuite mémorisée. */
    corner: Corner.catch("bottom-left"),
    margin_x: int(0, 4000, 6),
    margin_y: int(0, 4000, 6),
    width: int(CARD_SIZE.width.min, CARD_SIZE.width.max, CARD_SIZE.width.default),
    height: int(CARD_SIZE.height.min, CARD_SIZE.height.max, CARD_SIZE.height.default),
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
  notifications: section({
    /** Notifications du bureau quand la carte est fermée (jamais le texte des réponses). */
    enabled: bool(true),
    /** Claude a fini un tour, ou s'est arrêté sur une erreur. */
    done: bool(true),
    /** Autorisation demandée ou question posée. */
    requests: bool(true),
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

/** Nom de police : lettres, chiffres, espaces, « - », « _ », « . » (il est mis entre guillemets). */
const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

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
      /** Rayon des coins de la carte et de la pastille, en pixels (plafonné à l'intérieur). */
      radius: z.number().int().min(0).max(32).default(17),
      /** Taille du texte, relative à celle du système (1 = identique). */
      font_scale: z.number().min(0.7).max(1.5).default(0.95),
      /** Liseré de la couleur d'accent sous la carte et la pastille, en pixels (0 = aucun). */
      edge: z.number().int().min(0).max(4).default(0),
    })
    .default({ radius: 17, font_scale: 0.95, edge: 0 }),
  font: z
    .object({
      /** Famille installée (fc-list) ; absente = police du système. */
      family: z.string().regex(FONT_FAMILY_RE, "nom de police invalide").optional(),
      /** Graisse du texte, de 100 (fin) à 900 (très gras). */
      weight: z.number().int().min(100).max(900).multipleOf(100).default(400),
    })
    .default({ weight: 400 }),
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
  const { radius, font_scale, edge } = theme.shape;
  lines.push(`  --noko-radius: ${radius}px;`);
  // Coins des éléments intérieurs : jamais plus ronds que la carte.
  lines.push(`  --noko-radius-sm: ${Math.min(radius, 6)}px;`);
  lines.push(`  --noko-radius-md: ${Math.min(radius, 8)}px;`);
  lines.push(`  --noko-radius-lg: ${Math.min(radius, 10)}px;`);
  lines.push(`  font-size: ${font_scale}em;`);
  lines.push(`  font-weight: ${theme.font.weight};`);
  // Revalidé ici, comme les couleurs : rien d'autre qu'un nom de police entre guillemets.
  const family = theme.font.family;
  if (family !== undefined && FONT_FAMILY_RE.test(family)) lines.push(`  font-family: "${family}", sans-serif;`);
  const shell = [`border-radius: ${radius}px;`];
  if (edge > 0) shell.push(`border-bottom: ${edge}px solid var(--noko-accent);`);
  return ["window.noko-widget {", ...lines, "}", `.shell { ${shell.join(" ")} }`, ""].join("\n");
}

/** Couleur Hyprland « aarrggbb » (ex. « ee33ccff ») → rgba() CSS, ou null. */
export function hyprlandColor(value: string): string | null {
  const m = /^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(value);
  if (m === null) return null;
  const [a, r, g, b] = m.slice(1).map((h) => parseInt(h, 16)) as [number, number, number, number];
  return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(2))})`;
}

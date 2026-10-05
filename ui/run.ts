// Lanceur de l'UI (Node) : assemble ui/src en un seul module ES avec esbuild, puis
// lance GJS dessus. `--watch` réassemble et relance à chaque modification ;
// `--build-only` assemble sans lancer.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const OUTFILE = join(UI_DIR, "dist", "noko.js");

// gtk4-layer-shell doit être chargée avant libwayland-client : avec GJS, seul un
// préchargement le garantit (voir la documentation de gtk4-layer-shell).
const LAYER_SHELL_LIB = "/usr/lib/libgtk4-layer-shell.so";

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const buildOnly = args.has("--build-only");

const options: esbuild.BuildOptions = {
  entryPoints: [join(UI_DIR, "src", "app.ts")],
  outfile: OUTFILE,
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "esnext",
  // Modules fournis par GJS lui-même.
  external: ["gi://*", "resource://*", "system", "gettext", "cairo", "console"],
  loader: { ".css": "text" },
  jsx: "automatic",
  jsxImportSource: "gnim/gtk4",
  legalComments: "none",
  logLevel: "warning",
};

let child: ChildProcess | null = null;

/** Arrête l'instance en cours et attend sa sortie (l'application est à instance unique). */
async function stopUi(): Promise<void> {
  const current = child;
  if (current === null || current.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
  current.kill("SIGTERM");
  await exited;
}

async function startUi(): Promise<void> {
  await stopUi();
  child = spawn("gjs", ["-m", OUTFILE], {
    stdio: "inherit",
    env: { ...process.env, LD_PRELOAD: LAYER_SHELL_LIB },
  });
  child.once("error", (err) => {
    process.stderr.write(`noko : impossible de lancer gjs (${err.message})\n`);
    process.exitCode = 1;
  });
  if (!watch) {
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}

if (!buildOnly && !existsSync(LAYER_SHELL_LIB)) {
  process.stderr.write(`noko : ${LAYER_SHELL_LIB} introuvable (paquet gtk4-layer-shell)\n`);
  process.exit(1);
}

if (buildOnly) {
  await esbuild.build(options);
} else if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: "noko-restart",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length === 0) await startUi();
          });
        },
      },
    ],
  });
  await ctx.watch();
  const shutdown = () => {
    void ctx.dispose().then(stopUi).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  await esbuild.build(options);
  await startUi();
}

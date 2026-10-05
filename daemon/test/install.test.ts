import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addNokoHooks,
  changedLines,
  HOOK_SPECS,
  removeNokoHooks,
  SettingsShapeError,
  type Settings,
} from "../../hooks/settings-merge.ts";

const NODE = "/usr/bin/node";
const SCRIPT = "/opt/noko/hooks/noko-hook.ts";

const userHook = { type: "command", command: "/opt/bin/notify", timeout: 3 };

test("ajoute un hook par événement, en forme exec, avec un délai explicite", () => {
  const next = addNokoHooks({ model: "opus" }, NODE, SCRIPT);
  assert.equal(next.model, "opus");
  const hooks = next.hooks as Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
  assert.deepEqual(Object.keys(hooks), HOOK_SPECS.map((s) => s.event));
  for (const spec of HOOK_SPECS) {
    const [group] = hooks[spec.event]!;
    assert.equal(group?.matcher, spec.matcher);
    const [handler] = group!.hooks;
    assert.equal(handler?.type, "command");
    assert.equal(handler?.command, NODE);
    assert.deepEqual(handler?.args, [SCRIPT]);
    assert.ok(typeof handler?.timeout === "number" && handler.timeout <= 75);
  }
  assert.equal(hooks.Notification![0]!.matcher, "idle_prompt");
});

test("conserve les hooks existants, idempotent, et remplace un ancien chemin", () => {
  const settings: Settings = {
    hooks: {
      Stop: [{ hooks: [userHook] }],
      PreToolUse: [{ matcher: "Bash", hooks: [userHook] }],
    },
  };
  const once = addNokoHooks(settings, NODE, SCRIPT);
  const twice = addNokoHooks(once, NODE, SCRIPT);
  assert.deepEqual(twice, once);
  const hooks = once.hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.Stop![0], { hooks: [userHook] });
  assert.equal(hooks.Stop!.length, 2);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: "Bash", hooks: [userHook] }]);

  // Repo déplacé : l'ancienne entrée est remplacée, pas dupliquée.
  const moved = addNokoHooks(once, NODE, "/srv/noko/hooks/noko-hook.ts");
  const stop = (moved.hooks as Record<string, { hooks: { args?: string[] }[] }[]>).Stop!;
  assert.equal(stop.length, 2);
  assert.deepEqual(stop[1]!.hooks[0]!.args, ["/srv/noko/hooks/noko-hook.ts"]);
  // L'entrée d'origine n'est jamais modifiée.
  assert.equal((settings.hooks as Record<string, unknown[]>).Stop!.length, 1);
});

test("le retrait ne touche qu'aux entrées de noko", () => {
  const settings: Settings = { hooks: { Stop: [{ hooks: [userHook] }] }, env: { A: "b" } };
  const removed = removeNokoHooks(addNokoHooks(settings, NODE, SCRIPT));
  assert.deepEqual(removed, settings);
  assert.deepEqual(removeNokoHooks(addNokoHooks({}, NODE, SCRIPT)), {});
  // Groupe partagé avec un hook de l'utilisateur : seul celui de noko part.
  const shared: Settings = {
    hooks: { Stop: [{ hooks: [userHook, { type: "command", command: NODE, args: [SCRIPT] }] }] },
  };
  assert.deepEqual(removeNokoHooks(shared), { hooks: { Stop: [{ hooks: [userHook] }] } });
});

test("structure inattendue : erreur, rien n'est deviné", () => {
  for (const settings of [{ hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [{ matcher: "x" }] } }]) {
    assert.throws(() => addNokoHooks(settings as Settings, NODE, SCRIPT), SettingsShapeError);
  }
  assert.throws(() => addNokoHooks({}, "node", SCRIPT));
});

test("diff : uniquement les lignes modifiées, jamais le reste du fichier", () => {
  const before = JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-secret" } }, null, 2);
  const after = JSON.stringify(addNokoHooks(JSON.parse(before) as Settings, NODE, SCRIPT), null, 2);
  const diff = changedLines(before, after);
  assert.ok(diff.length > 0);
  assert.ok(diff.every((l) => l.startsWith("+ ") || l.startsWith("- ")));
  assert.equal(diff.join("\n").includes("sk-secret"), false);
  assert.deepEqual(changedLines("a\nb\nc", "a\nc"), ["- b"]);
  assert.deepEqual(changedLines("a", "a"), []);
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { OLD_SETTINGS_SECTION, SETTINGS_SECTION, SETTING_KEYS } from "../settingsKeys";

// Estes testes rodam a partir de out/test/, então a raiz do projeto fica dois níveis acima.
const root = path.resolve(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("SETTING_KEYS é igual às configurações declaradas no package.json", () => {
  const declared = Object.keys(pkg.contributes.configuration.properties).map((k) => {
    assert.ok(k.startsWith(`${SETTINGS_SECTION}.`), `${k} não usa o prefixo ${SETTINGS_SECTION}`);
    return k.slice(SETTINGS_SECTION.length + 1);
  });
  assert.deepEqual([...declared].sort(), [...SETTING_KEYS].sort());
});

test("todos os comandos, menus, atalhos e context keys usam o prefixo novo", () => {
  const ids = new Set<string>();
  for (const c of pkg.contributes.commands) ids.add(c.command);
  for (const k of pkg.contributes.keybindings) ids.add(k.command);
  for (const group of Object.values(pkg.contributes.menus) as Array<Array<{ command: string }>>) {
    for (const m of group) ids.add(m.command);
  }
  for (const id of ids) {
    assert.ok(id.startsWith(`${SETTINGS_SECTION}.`), `${id} não usa o prefixo ${SETTINGS_SECTION}`);
  }
  // Todo comando declarado é registrado no código, e vice-versa.
  const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
  for (const c of pkg.contributes.commands) {
    assert.ok(extension.includes(`"${c.command}"`), `${c.command} não está registrado em extension.ts`);
  }
});

test("o nome do produto não leva Claude, e o nome técnico é o novo", () => {
  assert.equal(pkg.name, "clite-ai");
  assert.equal(pkg.displayName, "CLIte-ai");
  for (const c of pkg.contributes.commands) {
    assert.ok(c.title.startsWith("CLIte-ai: "), c.title);
  }
});

test("o nome antigo não sobra no código nem no package.json (só na migração e nas notas)", () => {
  const targets = [
    path.join(root, "package.json"),
    ...fs
      .readdirSync(path.join(root, "src"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(root, "src", f)),
  ];
  const allowed = new Set(["settingsKeys.ts", "migration.ts"]);
  for (const file of targets) {
    if (allowed.has(path.basename(file))) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const old of [OLD_SETTINGS_SECTION, "Claude CLI Lite", "claude-cli-lite", "claude-proposal"]) {
      assert.ok(!text.includes(old), `${path.relative(root, file)} ainda cita "${old}"`);
    }
  }
});

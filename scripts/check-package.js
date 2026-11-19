// Confere que o .vsix só leva arquivos esperados (lista de permissão).
// Roda `vsce ls` e falha se aparecer qualquer arquivo fora da lista.
const { execFileSync } = require("child_process");
const path = require("path");

const vsce = path.join(path.dirname(require.resolve("@vscode/vsce/package.json")), "vsce");
const out = execFileSync(process.execPath, [vsce, "ls", "--no-dependencies"], { encoding: "utf8" });
const files = out.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, "/")).filter(Boolean);

const allowed = /^(out\/[^/]+\.js|package\.json|README\.md|CHANGELOG\.md|LICENSE|NOTICE)$/;
const required = ["package.json", "README.md", "LICENSE", "NOTICE", "out/extension.js"];

const unexpected = files.filter((f) => !allowed.test(f));
const missing = required.filter((f) => !files.includes(f));

if (unexpected.length || missing.length) {
  if (unexpected.length) console.error("Arquivos inesperados no pacote:\n  " + unexpected.join("\n  "));
  if (missing.length) console.error("Arquivos que deveriam estar no pacote e não estão:\n  " + missing.join("\n  "));
  process.exit(1);
}
console.log(`Pacote ok: ${files.length} arquivos, todos esperados.`);

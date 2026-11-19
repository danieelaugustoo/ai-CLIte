import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildPreview, estimateTokens, extractPromptFromPreview, PreviewInput } from "../preview";

const base: PreviewInput = {
  engine: "Claude Code CLI",
  model: "",
  cwdMode: "neutra",
  workspaceTrusted: true,
  args: ["-p", "--tools", "", "--setting-sources", "user"],
  prompt: "<pedido_ab12>\nExplique\n</pedido_ab12>",
  files: [{ path: "src/a.ts", chars: 120 }],
  historyTurns: 1,
  historyChars: 300,
  selectionChars: 40,
  notes: [],
};

test("a prévia traz o texto enviado exatamente, byte a byte", () => {
  const prompts = [base.prompt, "linha 1\n\nlinha com `crases` e <tags>\n  indentada\n", "emoji 😀 e acentuação\r\nCRLF", ""];
  for (const prompt of prompts) {
    const preview = buildPreview({ ...base, prompt });
    assert.equal(extractPromptFromPreview(preview), prompt);
  }
});

test("mostra motor, pasta neutra, workspace e argumentos com o vazio visível", () => {
  const text = buildPreview(base);
  assert.match(text, /Motor: Claude Code CLI/);
  assert.match(text, /Modelo: \(o padrão da CLI\)/);
  assert.match(text, /temporária e vazia/);
  assert.match(text, /Workspace: confiável/);
  assert.match(text, /--tools "" --setting-sources user/);
});

test("avisa quando a pasta é a do projeto e quando o workspace não é confiável", () => {
  const text = buildPreview({ ...base, cwdMode: "projeto", workspaceTrusted: false, model: "sonnet" });
  assert.match(text, /a do seu projeto/);
  assert.match(text, /branch, autor e últimos commits/);
  assert.match(text, /NÃO confiável/);
  assert.match(text, /Modelo: sonnet/);
});

test("lista cada arquivo do contexto com o tamanho", () => {
  const text = buildPreview({ ...base, files: [{ path: "a.ts", chars: 10 }, { path: "b/c.py", chars: 2000 }] });
  assert.match(text, /Arquivos do contexto \(2\):/);
  assert.match(text, /- a\.ts \(10 caracteres\)/);
  assert.match(text, /- b\/c\.py \(2000 caracteres\)/);
  assert.match(buildPreview({ ...base, files: [] }), /Arquivos do contexto: nenhum/);
});

test("a estimativa de tokens é rotulada como estimativa", () => {
  assert.equal(estimateTokens(400), 100);
  assert.equal(estimateTokens(401), 101);
  assert.match(buildPreview(base), /só uma estimativa/);
});

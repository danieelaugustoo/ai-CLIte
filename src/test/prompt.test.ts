import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildFullPrompt, buildPrompt, longestBacktickRun } from "../prompt";

test("longestBacktickRun acha a maior sequência de crases", () => {
  assert.equal(longestBacktickRun("sem crases"), 0);
  assert.equal(longestBacktickRun("`a` ``b`` ```c```"), 3);
  assert.equal(longestBacktickRun("a ````` b"), 5);
});

test("buildPrompt usa uma cerca maior do que qualquer sequência do código", () => {
  const code = "const s = `x`;\n```js\ninterno\n```\n";
  const text = buildPrompt({
    instruction: "explica",
    code,
    relativePath: "src/a.ts",
    startLine: 3,
    endLine: 3,
    languageId: "typescript",
  });
  assert.match(text, /^explica\n/);
  assert.match(text, /linha 3\)/);
  const fence = /^(`{4,})typescript$/m.exec(text);
  assert.ok(fence, "a cerca de abertura deveria ter 4 crases ou mais");
  assert.ok(text.trimEnd().endsWith(fence[1]), "a cerca de fechamento deveria ser igual à de abertura");
});

test("buildPrompt mostra a faixa de linhas quando a seleção tem várias", () => {
  const text = buildPrompt({
    instruction: "x",
    code: "a",
    relativePath: "a.py",
    startLine: 10,
    endLine: 14,
    languageId: "python",
  });
  assert.match(text, /linhas 10-14/);
});

test("buildFullPrompt só inclui as seções que têm conteúdo, na ordem contexto, histórico, pedido", () => {
  const sozinho = buildFullPrompt({ files: [], turns: [], request: "oi", hasTarget: false });
  assert.ok(sozinho.includes("<pedido>\noi\n</pedido>"));
  assert.ok(!sozinho.includes("<contexto>"));
  assert.ok(!sozinho.includes("<historico>"));

  const completo = buildFullPrompt({
    files: [{ path: "a.ts", lang: "typescript", content: "let a = 1;" }],
    turns: [{ request: "p1", response: "r1" }],
    request: "p2",
    hasTarget: true,
  });
  const ctx = completo.indexOf("<contexto>");
  const hist = completo.indexOf("<historico>");
  const ped = completo.indexOf("<pedido>");
  assert.ok(ctx >= 0 && ctx < hist && hist < ped);
  assert.ok(completo.indexOf("</pedido>") < completo.length - 1, "com alvo, vem uma regra depois do pedido");
});

test("buildFullPrompt usa cerca maior no conteúdo dos arquivos do carrinho", () => {
  const prompt = buildFullPrompt({
    files: [{ path: "doc.md", lang: "markdown", content: "```js\nx\n```" }],
    turns: [],
    request: "r",
    hasTarget: false,
  });
  assert.match(prompt, /^`{4,}markdown$/m);
});

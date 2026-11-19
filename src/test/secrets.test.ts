import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findSecrets, redact, StreamRedactor } from "../secrets";

// Os valores são montados na hora para não parecerem chaves reais no código-fonte.
const A = (n: number) => "A".repeat(n);
const anthropic = "sk-ant-" + "api03-" + A(40);
const openai = "sk-" + "proj-" + A(30);
const xai = "xai-" + A(30);
const google = "AIza" + A(35);
const aws = "AKIA" + "B".repeat(16);
const github = "ghp_" + A(36);
const slack = "xoxb-" + "1234567890-" + A(12);
const jwt = ["eyJ" + A(12), A(12), A(12)].join(".");
const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END RSA PRIVATE KEY-----";

test("redige os formatos conhecidos de chave", () => {
  const cases: [string, string][] = [
    [anthropic, "chave Anthropic"],
    [openai, "chave OpenAI"],
    [xai, "chave xAI"],
    [google, "chave Google"],
    [aws, "chave AWS"],
    [github, "token GitHub"],
    [slack, "token Slack"],
    [jwt, "JWT"],
    [privateKey, "chave privada"],
  ];
  for (const [secret, type] of cases) {
    const out = redact(`antes ${secret} depois`);
    assert.ok(!out.includes(secret.slice(8, 30)), `${type} vazou: ${out}`);
    assert.ok(out.includes(`[REDACTED:${type}]`), `${type}: ${out}`);
    assert.ok(out.startsWith("antes ") && out.endsWith(" depois"));
  }
});

test("redige Bearer e atribuições, mantendo o rótulo", () => {
  assert.equal(redact("Authorization: Bearer " + A(30)), "Authorization: Bearer [REDACTED:token Bearer]");
  assert.equal(redact('api_key = "abc123def456ghi"'), 'api_key = "[REDACTED:valor secreto]"');
});

test("não confunde código comum com segredo", () => {
  for (const ok of ["token = getToken()", "password = input()", "const secret = 'abc'", "texto normal sem nada", "sk-curto"]) {
    assert.equal(redact(ok), ok, ok);
  }
});

test("findSecrets devolve tipo e linha, nunca o valor", () => {
  const found = findSecrets(`ok\nok\nchave: ${anthropic}\nfim`);
  assert.deepEqual(found, [{ type: "chave Anthropic", line: 3 }]);
  assert.ok(!JSON.stringify(found).includes("api03"));
});

test("StreamRedactor: segredo cortado entre pedaços não vaza", () => {
  const text = `linha 1\nsua chave: ${anthropic}\nfim\n`;
  for (const size of [1, 3, 7, 16]) {
    const r = new StreamRedactor();
    let out = "";
    for (let i = 0; i < text.length; i += size) {
      out += r.push(text.slice(i, i + size));
    }
    out += r.flush();
    assert.ok(!out.includes(A(10)), `tamanho ${size}: ${out}`);
    assert.ok(out.includes("[REDACTED:chave Anthropic]"));
    assert.ok(out.startsWith("linha 1\n") && out.includes("fim"));
  }
});

test("StreamRedactor: segura o bloco de chave privada até ele fechar", () => {
  const text = `antes\n${privateKey}\ndepois\n`;
  const r = new StreamRedactor();
  let out = "";
  for (let i = 0; i < text.length; i += 5) {
    out += r.push(text.slice(i, i + 5));
    assert.ok(!out.includes("MIIEvQ"), "o corpo da chave não pode aparecer no meio do caminho");
  }
  out += r.flush();
  assert.ok(out.includes("[REDACTED:chave privada]"));
  assert.ok(!out.includes("MIIEvQ"));
  assert.ok(out.includes("depois"));
});

test("StreamRedactor: texto sem segredo sai inteiro e na ordem", () => {
  const r = new StreamRedactor();
  const parts = ["Olá, ", "mundo\n", "segunda ", "linha"];
  const out = parts.map((p) => r.push(p)).join("") + r.flush();
  assert.equal(out, "Olá, mundo\nsegunda linha");
});

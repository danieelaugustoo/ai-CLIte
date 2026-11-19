import { test } from "node:test";
import { strict as assert } from "node:assert";
import { describeReadError, findHiddenChars, isInsideAny, isSensitivePath } from "../cartPolicy";

test("reconhece arquivos sensíveis pelo nome e pela pasta", () => {
  for (const f of [
    "/p/.env", "/p/.env.local", "/p/.env.production", "C:\\p\\.env", "/p/key.pem", "/p/server.key",
    "/home/u/.ssh/config", "/home/u/id_rsa", "/p/credentials.json", "/p/.npmrc", "/p/.aws/credentials",
    "/p/terraform.tfstate", "/p/prod.tfvars", "/p/service-account-prod.json", "/p/.git/config", "/p/secrets.yaml", "/p/secrets", "/p/.secrets", "/p/credentials", "/p/credentials.yml", "/p/secrets.json",
  ]) {
    assert.equal(isSensitivePath(f), true, f);
  }
});

test("não marca arquivos comuns nem os modelos de .env", () => {
  for (const f of ["/p/src/app.ts", "/p/README.md", "/p/.env.example", "/p/.env.sample", "/p/config.json", "/p/.gitignore", "/p/id_rsa.pub", "/p/keyboard.ts", "/p/src/secrets.ts", "/p/src/credentials.service.ts", "/p/lib/secret.py", "/p/docs/secrets-management.md", "/p/SecretsManager.java"]) {
    assert.equal(isSensitivePath(f), false, f);
  }
});

test("isInsideAny: dentro, fora e tentativa de sair com ..", () => {
  assert.equal(isInsideAny("/work/proj/src/a.ts", ["/work/proj"]), true);
  assert.equal(isInsideAny("/work/proj", ["/work/proj"]), true);
  assert.equal(isInsideAny("/work/other/a.ts", ["/work/proj"]), false);
  assert.equal(isInsideAny("/work/proj-evil/a.ts", ["/work/proj"]), false);
  assert.equal(isInsideAny("/work/proj/../secret/a.ts", ["/work/proj"]), false);
  assert.equal(isInsideAny("/etc/passwd", []), false);
});

test("isInsideAny: caminhos do Windows", () => {
  assert.equal(isInsideAny("C:\\Users\\a\\proj\\src\\x.ts", ["C:\\Users\\a\\proj"]), true);
  assert.equal(isInsideAny("c:\\users\\a\\proj\\x.ts", ["C:\\Users\\a\\proj"]), true);
  assert.equal(isInsideAny("C:\\Users\\a\\outro\\x.ts", ["C:\\Users\\a\\proj"]), false);
  assert.equal(isInsideAny("D:\\proj\\x.ts", ["C:\\proj"]), false);
});

test("findHiddenChars acha bidi e invisíveis, com a linha", () => {
  const text = "ok\nconst a = '\u202Eevil';\nfim\u200B\n";
  assert.deepEqual(findHiddenChars(text), [
    { kind: "bidi", line: 2 },
    { kind: "invisível", line: 3 },
  ]);
  assert.deepEqual(findHiddenChars("\uFEFFcom BOM no começo, sem alerta"), []);
  assert.deepEqual(findHiddenChars("texto normal, com acentuação e emoji 😀"), []);
});

test("describeReadError separa os motivos", () => {
  assert.equal(describeReadError({ code: "FileNotFound" }).kind, "missing");
  assert.equal(describeReadError(new Error("Unable to read file: ENOENT")).kind, "missing");
  assert.equal(describeReadError({ code: "NoPermissions" }).kind, "denied");
  assert.equal(describeReadError(new Error("EACCES: permission denied")).kind, "denied");
  assert.equal(describeReadError(new Error("The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.")).kind, "binary");
  assert.equal(describeReadError(new Error("File is too large")).kind, "toolarge");
  assert.equal(describeReadError(new Error("algo estranho")).kind, "other");
});

test("findHiddenChars: emoji com ZWJ e persa com ZWNJ não contam", () => {
  assert.deepEqual(findHiddenChars("família 👨\u200d👩\u200d👧 ok"), []);
  assert.deepEqual(findHiddenChars("pessoa 🧑🏽\u200d💻 programando, bandeira 🏳️\u200d🌈"), []);
  assert.deepEqual(findHiddenChars("می\u200cخواهم"), []); // persa
  assert.deepEqual(findHiddenChars("क्\u200cष"), []); // devanágari
});

test("findHiddenChars: ZWJ e ZWNJ fora de contexto, ZWSP e bidi ainda contam", () => {
  assert.deepEqual(findHiddenChars("ab\u200dcd"), [{ kind: "invisível", line: 1 }]);
  assert.deepEqual(findHiddenChars("ab\u200ccd"), [{ kind: "invisível", line: 1 }]);
  assert.deepEqual(findHiddenChars("a\n\u200Bb"), [{ kind: "invisível", line: 2 }]);
  assert.deepEqual(findHiddenChars("x\u2066y"), [{ kind: "bidi", line: 1 }]);
  assert.deepEqual(findHiddenChars("😀\u200dabc"), [{ kind: "invisível", line: 1 }]);
});

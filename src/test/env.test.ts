import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildChildEnv } from "../env";

test("deixa passar só o que a CLI precisa", () => {
  const { env, names } = buildChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/a",
    LANG: "pt_BR.UTF-8",
    LC_ALL: "C",
    ANTHROPIC_API_KEY: "valor-fake",
    CLAUDE_CODE_USE_BEDROCK: "1",
    HTTPS_PROXY: "http://p:1",
    NODE_EXTRA_CA_CERTS: "/c.pem",
  });
  assert.deepEqual(names, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "PATH"]);
  assert.equal(env.ANTHROPIC_API_KEY, "valor-fake");
});

test("descarta segredos de outros serviços e variáveis que carregam código", () => {
  const { env } = buildChildEnv({
    PATH: "/usr/bin",
    AWS_SECRET_ACCESS_KEY: "x",
    AWS_ACCESS_KEY_ID: "x",
    GITHUB_TOKEN: "x",
    OPENAI_API_KEY: "x",
    DATABASE_URL: "x",
    NODE_OPTIONS: "--require /tmp/evil.js",
    LD_PRELOAD: "/tmp/evil.so",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    ELECTRON_RUN_AS_NODE: "1",
    VSCODE_IPC_HOOK: "x",
  });
  assert.deepEqual(Object.keys(env), ["PATH"]);
});

test("os nomes no Windows não diferenciam maiúsculas (Path, SystemRoot)", () => {
  const { names } = buildChildEnv({ Path: "C:\\x", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", Segredo: "x" });
  assert.deepEqual(names, ["ComSpec", "Path", "SystemRoot"]);
});

test("nomes extras permitidos pelo usuário passam; nomes inválidos são ignorados", () => {
  const { names } = buildChildEnv({ PATH: "/x", AWS_PROFILE: "p", AWS_REGION: "r", SEGREDO: "s" }, ["aws_profile", "AWS_REGION", "nome inválido!", ""]);
  assert.deepEqual(names, ["AWS_PROFILE", "AWS_REGION", "PATH"]);
});

test("não devolve valores na lista de nomes", () => {
  const { names } = buildChildEnv({ ANTHROPIC_API_KEY: "sk-ant-segredo" });
  assert.ok(!JSON.stringify(names).includes("segredo"));
});

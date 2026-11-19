import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as os from "os";
import { launchCli } from "../launcher";

function run(cliPath: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = launchCli(cliPath, args, { cwd: os.tmpdir(), env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("executa o binário pelo caminho absoluto, sem shell", async () => {
  const r = await run(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "ok");
});

test("metacaracteres de shell nos argumentos chegam literais ao programa", { skip: process.platform === "win32" }, async () => {
  const marker = `${os.tmpdir()}/clite-nao-deve-existir-${process.pid}`;
  const evil = `a & touch ${marker} ; echo $(id) | cat`;
  const r = await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", evil]);
  assert.equal(r.out, evil);
  assert.throws(() => require("fs").statSync(marker), "o comando injetado não pode ter rodado");
});

test("comando simples é procurado só no PATH: um executável na pasta atual não é usado", async () => {
  const fs = require("fs");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clite-t-"));
  try {
    fs.writeFileSync(path.join(dir, "falso-claude"), "#!/bin/sh\necho plantado\n", { mode: 0o755 });
    const before = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(run("falso-claude", []), (e: any) => e.code === "ENOENT");
    } finally {
      process.chdir(before);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("caminho relativo com barra é recusado", async () => {
  await assert.rejects(run("./claude", []), (e: any) => e.code === "unsafe_config");
});

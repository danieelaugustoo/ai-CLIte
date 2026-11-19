import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildCmdLine, resolveExecutable, UnsafeConfigError } from "../executable";

/** Cria um isFile falso que só reconhece os caminhos dados e registra o que foi consultado. */
function fakeFs(existing: string[]) {
  const asked: string[] = [];
  return {
    asked,
    isFile: (p: string) => {
      asked.push(p);
      return existing.includes(p);
    },
  };
}

test("posix: acha o comando simples no PATH", () => {
  const fsx = fakeFs(["/usr/local/bin/claude"]);
  const r = resolveExecutable("claude", { platform: "linux", env: { PATH: "/usr/bin:/usr/local/bin" }, isFile: fsx.isFile });
  assert.deepEqual(r, { path: "/usr/local/bin/claude", kind: "exe" });
});

test("posix: pastas vazias ou relativas no PATH (a pasta atual) são ignoradas", () => {
  const fsx = fakeFs(["claude", "./claude", "bin/claude"]);
  assert.throws(
    () => resolveExecutable("claude", { platform: "linux", env: { PATH: ":.:bin:/usr/bin" }, isFile: fsx.isFile }),
    (e: any) => e.code === "ENOENT"
  );
  assert.ok(fsx.asked.every((p) => p.startsWith("/")), "só caminhos absolutos podem ser consultados");
});

test("caminho com barras precisa ser absoluto", () => {
  for (const bad of ["./claude", "bin/claude", "../claude"]) {
    assert.throws(
      () => resolveExecutable(bad, { platform: "linux", env: { PATH: "/usr/bin" }, isFile: () => true }),
      UnsafeConfigError,
      bad
    );
  }
});

test("caminho absoluto inexistente dá ENOENT, e existente passa", () => {
  assert.throws(
    () => resolveExecutable("/opt/x/claude", { platform: "linux", env: {}, isFile: () => false }),
    (e: any) => e.code === "ENOENT"
  );
  assert.equal(resolveExecutable("/opt/x/claude", { platform: "linux", env: {}, isFile: () => true }).path, "/opt/x/claude");
});

test("recusa caracteres de controle no cliPath", () => {
  assert.throws(() => resolveExecutable("claude\nrm", { platform: "linux", env: {}, isFile: () => true }), UnsafeConfigError);
});

test("windows: acha o shim .cmd do npm e a pasta atual nunca é consultada", () => {
  const npm = "C:\\Users\\ana\\AppData\\Roaming\\npm";
  const fsx = fakeFs([`${npm}\\claude.cmd`, "claude.cmd", ".\\claude.cmd", "C:\\repo\\claude.cmd"]);
  const r = resolveExecutable("claude", {
    platform: "win32",
    env: { Path: `.;C:\\Windows\\System32;${npm}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    isFile: fsx.isFile,
  });
  assert.deepEqual(r, { path: `${npm}\\claude.cmd`, kind: "cmd" });
  assert.ok(fsx.asked.every((p) => /^[A-Za-z]:\\/.test(p)), "só caminhos absolutos");
});

test("windows: prefere .exe a .cmd conforme a ordem do PATHEXT, e ignora extensões de script", () => {
  const dir = "C:\\tools";
  const fsx = fakeFs([`${dir}\\claude.vbs`, `${dir}\\claude.cmd`, `${dir}\\claude.exe`]);
  const r = resolveExecutable("claude", {
    platform: "win32",
    env: { PATH: dir, PATHEXT: ".VBS;.EXE;.CMD" },
    isFile: fsx.isFile,
  });
  assert.deepEqual(r, { path: `${dir}\\claude.exe`, kind: "exe" });
  assert.ok(!fsx.asked.some((p) => p.endsWith(".vbs")), ".vbs nunca é candidato");
});

test("windows: nome com extensão não recebe outra extensão", () => {
  const fsx = fakeFs(["C:\\a\\claude.cmd"]);
  const r = resolveExecutable("claude.cmd", { platform: "win32", env: { PATH: "C:\\a" }, isFile: fsx.isFile });
  assert.equal(r.path, "C:\\a\\claude.cmd");
});

test("windows: caminho absoluto com extensão não suportada é recusado", () => {
  assert.throws(
    () => resolveExecutable("C:\\a\\claude.ps1", { platform: "win32", env: {}, isFile: () => true }),
    UnsafeConfigError
  );
});

test("cmd.exe: monta a linha com argumentos permitidos, incluindo o vazio", () => {
  const line = buildCmdLine("C:\\Program Files (x86)\\npm\\claude.cmd", [
    "-p",
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--model",
    "claude-sonnet-4-5[1m]",
    "--setting-sources",
    "user",
  ]);
  assert.equal(
    line,
    '"C:\\Program Files (x86)\\npm\\claude.cmd" -p --tools "" --disallowedTools mcp__* --model claude-sonnet-4-5[1m] --setting-sources user'
  );
});

test("cmd.exe: recusa argumentos com metacaracteres", () => {
  for (const arg of ["a&b", "a|b", "a^b", "a%PATH%", "a!b", 'a"b', "a b", "a<b", "a>b", "a\\b", "a\nb", "a;b", "a(b)"]) {
    assert.throws(() => buildCmdLine("C:\\x\\claude.cmd", [arg]), UnsafeConfigError, JSON.stringify(arg));
  }
});

test("cmd.exe: recusa caminho do .cmd com aspas, % ou !", () => {
  for (const p of ['C:\\a"b\\claude.cmd', "C:\\%TEMP%\\claude.cmd", "C:\\a!b\\claude.cmd"]) {
    assert.throws(() => buildCmdLine(p, ["-p"]), UnsafeConfigError, p);
  }
});

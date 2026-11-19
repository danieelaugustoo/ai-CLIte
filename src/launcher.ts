/**
 * Inicia a CLI sem shell (S4). Sem dependência do `vscode`.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { buildCmdLine, resolveExecutable } from "./executable";

export interface LaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function isRunnableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    if (platform !== "win32") {
      fs.accessSync(file, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function launchCli(cliPath: string, args: string[], options: LaunchOptions): ChildProcessWithoutNullStreams {
  const platform = process.platform;
  const resolved = resolveExecutable(cliPath, {
    platform,
    env: options.env,
    isFile: (file) => isRunnableFile(file, platform),
  });

  if (platform === "win32" && resolved.kind === "cmd") {
    // O shim do npm (.cmd) só roda pelo cmd.exe. Chamamos o cmd.exe pelo caminho
    // absoluto e entregamos a linha pronta, com argumentos já validados.
    const systemRoot = options.env.SystemRoot || options.env.SYSTEMROOT || "C:\\Windows";
    const cmdExe = path.win32.join(systemRoot, "System32", "cmd.exe");
    const line = buildCmdLine(resolved.path, args);
    return spawn(cmdExe, ["/d", "/s", "/c", `"${line}"`], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(resolved.path, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    // Fora do Windows o processo vira líder de um grupo, para podermos encerrar
    // ele e os filhos dele de uma vez (ver lifecycle.ts).
    detached: platform !== "win32",
  });
}

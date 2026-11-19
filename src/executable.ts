/**
 * Resolução segura do executável da CLI e montagem da linha de comando para o
 * cmd.exe (S4). Sem dependência do `vscode`, para poder ser testado com node:test.
 *
 * Regras:
 *  - nunca usamos shell: o caminho do executável é resolvido aqui, em JavaScript;
 *  - um nome simples (ex.: "claude") só é procurado nas pastas absolutas do PATH,
 *    NUNCA na pasta atual (no Windows o CreateProcess procura nela primeiro, e um
 *    repositório poderia plantar um claude.cmd);
 *  - um caminho com barras precisa ser absoluto.
 */

import * as path from "path";

export class UnsafeConfigError extends Error {
  readonly code = "unsafe_config";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeConfigError";
  }
}

export interface NotFoundError extends Error {
  code: "ENOENT";
}

function notFound(name: string): NotFoundError {
  const err = new Error(`executável "${name}" não encontrado`) as NotFoundError;
  err.code = "ENOENT";
  return err;
}

export type ExecKind = "exe" | "cmd";

export interface Resolved {
  path: string;
  kind: ExecKind;
}

export interface ResolveOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** true se existir um arquivo executável nesse caminho absoluto. */
  isFile: (absolutePath: string) => boolean;
}

/** Extensões que aceitamos no Windows, nesta ordem de preferência. */
const WIN_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

function kindOf(file: string, platform: NodeJS.Platform): ExecKind {
  if (platform !== "win32") {
    return "exe";
  }
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return "cmd";
  }
  if (ext === ".exe" || ext === ".com") {
    return "exe";
  }
  throw new UnsafeConfigError(`tipo de arquivo não suportado no Windows: "${ext || "sem extensão"}" (use .exe, .cmd ou .bat)`);
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  // No Windows os nomes de variáveis não diferenciam maiúsculas.
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return (key && env[key]) || "";
}

export function resolveExecutable(cliPath: string, opts: ResolveOptions): Resolved {
  const win = opts.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const raw = (cliPath ?? "").trim() || "claude";

  if (/[\0\r\n]/.test(raw)) {
    throw new UnsafeConfigError("cliPath tem caracteres de controle");
  }

  const hasSeparator = raw.includes("/") || (win && raw.includes("\\"));
  if (hasSeparator || p.isAbsolute(raw)) {
    if (!p.isAbsolute(raw)) {
      throw new UnsafeConfigError(
        'cliPath com barras precisa ser um caminho absoluto (ou só o nome do comando, como "claude", para procurar no PATH)'
      );
    }
    if (!opts.isFile(raw)) {
      throw notFound(raw);
    }
    return { path: raw, kind: kindOf(raw, opts.platform) };
  }

  const dirs = envValue(opts.env, "PATH")
    .split(win ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    // Entradas vazias ou relativas equivalem à pasta atual: ficam de fora.
    .filter((d) => d !== "" && p.isAbsolute(d));

  let candidates: string[];
  if (win) {
    const fromEnv = envValue(opts.env, "PATHEXT")
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => WIN_EXTENSIONS.includes(e));
    const exts = fromEnv.length > 0 ? fromEnv : WIN_EXTENSIONS;
    const lower = raw.toLowerCase();
    candidates = exts.some((e) => lower.endsWith(e)) ? [raw] : exts.map((e) => raw + e);
  } else {
    candidates = [raw];
  }

  for (const dir of dirs) {
    for (const name of candidates) {
      const full = p.join(dir, name);
      if (opts.isFile(full)) {
        return { path: full, kind: kindOf(full, opts.platform) };
      }
    }
  }
  throw notFound(raw);
}

/**
 * Argumentos aceitos na linha do cmd.exe: só caracteres sem significado especial.
 * Ficam de fora espaço, aspas, & | < > ^ % ! e barra invertida.
 */
const SAFE_CMD_ARG = /^[A-Za-z0-9._:/=@,+*[\]-]+$/;

/**
 * Monta a linha de comando para `cmd.exe /d /s /c "<linha>"`.
 * O caminho do .cmd vai entre aspas (pode ter espaços e parênteses); os
 * argumentos precisam passar pela lista de permitidos, e o argumento vazio vai
 * como `""`. Qualquer coisa fora disso vira erro `unsafe_config`, nunca é escapada
 * às cegas.
 * [NÃO VERIFICADO em Windows real] que o `""` chega vazio ao programa através do shim.
 */
export function buildCmdLine(cmdPath: string, args: string[]): string {
  if (/["%!\r\n\0]/.test(cmdPath)) {
    throw new UnsafeConfigError('o caminho da CLI tem caracteres que o cmd.exe interpretaria (aspas, "%" ou "!")');
  }
  const parts = args.map((arg) => {
    if (arg === "") {
      return '""';
    }
    if (!SAFE_CMD_ARG.test(arg)) {
      throw new UnsafeConfigError(`argumento não permitido na linha do cmd.exe: "${arg.slice(0, 40)}"`);
    }
    return arg;
  });
  return [`"${cmdPath}"`, ...parts].join(" ");
}

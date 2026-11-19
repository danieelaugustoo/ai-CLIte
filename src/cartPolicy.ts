/**
 * Regras do carrinho de contexto (S17), sem dependência do `vscode` para poderem
 * ser testadas com node:test.
 */

import * as path from "path";

// ---------------------------------------------------------------------------
// Arquivos sensíveis
// ---------------------------------------------------------------------------

/** Modelos que costumam ser seguros de compartilhar (.env.example etc.). */
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;

const SENSITIVE_NAMES: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials(\..+)?$/i,
  /^\.?secrets?(\..+)?$/i,
  /^\.(npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd)$/i,
  /\.(tfstate|tfvars)$/i,
  /^service-?account.*\.json$/i,
];

const SENSITIVE_DIRS = [".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker"];

/** O nome ou a pasta do arquivo indica que ele pode ter segredos? */
export function isSensitivePath(file: string): boolean {
  const parts = file.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (TEMPLATE_SUFFIX.test(base)) {
    return false;
  }
  if (parts.slice(0, -1).some((d) => SENSITIVE_DIRS.includes(d.toLowerCase()))) {
    return true;
  }
  return SENSITIVE_NAMES.some((re) => re.test(base));
}

// ---------------------------------------------------------------------------
// Dentro ou fora do workspace
// ---------------------------------------------------------------------------

function libFor(file: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\") ? path.win32 : path.posix;
}

/** O arquivo está dentro de alguma das pastas-raiz? (Caminhos já resolvidos, sem links.) */
export function isInsideAny(file: string, roots: string[]): boolean {
  const lib = libFor(file);
  return roots.some((root) => {
    const rel = lib.relative(root, file);
    return rel === "" || (!rel.startsWith("..") && !lib.isAbsolute(rel));
  });
}

// ---------------------------------------------------------------------------
// Caracteres ocultos
// ---------------------------------------------------------------------------

export interface HiddenFinding {
  kind: "bidi" | "invisível";
  line: number;
}

/**
 * Acha caracteres de controle de direção (bidi) e invisíveis. Eles permitem
 * esconder texto ou fazer o código parecer outra coisa ("Trojan Source").
 * Devolve no máximo 5 ocorrências.
 */
export function findHiddenChars(text: string): HiddenFinding[] {
  const found: HiddenFinding[] = [];
  let line = 1;
  for (let i = 0; i < text.length && found.length < 5; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      line++;
    } else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      found.push({ kind: "bidi", line });
    } else if ((c >= 0x200b && c <= 0x200d) || c === 0x2060 || (c === 0xfeff && i > 0)) {
      found.push({ kind: "invisível", line });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Erros de leitura
// ---------------------------------------------------------------------------

export type ReadErrorKind = "missing" | "denied" | "binary" | "toolarge" | "other";

/** Classifica o erro ao abrir um arquivo, para não dizer "não existe" quando é outra coisa. */
export function describeReadError(err: unknown): { kind: ReadErrorKind; detail: string } {
  const e = err as { code?: unknown; message?: unknown } | undefined;
  const code = String(e?.code ?? "");
  const message = String(e?.message ?? err ?? "");
  if (/FileNotFound|ENOENT/i.test(code) || /ENOENT|nonexistent|non-existent|does not exist/i.test(message)) {
    return { kind: "missing", detail: "não existe" };
  }
  if (/NoPermissions|EACCES|EPERM/i.test(code) || /EACCES|EPERM|permission denied/i.test(message)) {
    return { kind: "denied", detail: "sem permissão de leitura" };
  }
  if (/binary|unsupported text encoding/i.test(message)) {
    return { kind: "binary", detail: "parece binário ou usa uma codificação não suportada" };
  }
  if (/too large|file is too large|exceeds/i.test(message)) {
    return { kind: "toolarge", detail: "grande demais para abrir" };
  }
  return { kind: "other", detail: message.slice(0, 120) || "erro desconhecido" };
}

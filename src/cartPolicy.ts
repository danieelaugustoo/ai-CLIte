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
  // Só nomes sem extensão ou com extensão de dados: "secrets.ts" e "credentials.service.ts" são código.
  /^credentials(\.(json|ya?ml|toml|ini|txt|csv|xml|env|enc))?$/i,
  /^\.?secrets?(\.(json|ya?ml|toml|ini|txt|csv|xml|env|enc))?$/i,
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

const EMOJI_LIKE = /[\p{Extended_Pictographic}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/u;
/** Escritas em que o ZWNJ (U+200C) é parte normal do texto. */
const ZWNJ_SCRIPTS =
  /[\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Sinhala}]/u;

/**
 * Acha caracteres de controle de direção (bidi) e invisíveis. Eles permitem
 * esconder texto ou fazer o código parecer outra coisa ("Trojan Source").
 * O ZWJ (U+200D) dentro de uma sequência de emoji e o ZWNJ (U+200C) entre letras
 * de escritas que o usam (persa, hindi...) são normais e não contam.
 * Devolve no máximo 5 ocorrências.
 */
export function findHiddenChars(text: string): HiddenFinding[] {
  const found: HiddenFinding[] = [];
  const chars = Array.from(text); // por ponto de código, para os emoji de 2 unidades
  let line = 1;
  for (let i = 0; i < chars.length && found.length < 5; i++) {
    const ch = chars[i];
    const c = ch.codePointAt(0) as number;
    if (c === 10) {
      line++;
    } else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      found.push({ kind: "bidi", line });
    } else if (c === 0x200d) {
      const legit = EMOJI_LIKE.test(chars[i - 1] ?? "") && EMOJI_LIKE.test(chars[i + 1] ?? "");
      if (!legit) {
        found.push({ kind: "invisível", line });
      }
    } else if (c === 0x200c) {
      const legit = ZWNJ_SCRIPTS.test(chars[i - 1] ?? "") && ZWNJ_SCRIPTS.test(chars[i + 1] ?? "");
      if (!legit) {
        found.push({ kind: "invisível", line });
      }
    } else if (c === 0x200b || c === 0x2060 || (c === 0xfeff && i > 0)) {
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

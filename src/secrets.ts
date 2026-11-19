/**
 * Detecção e redação de segredos (S11, e base do scanner do carrinho no S17).
 * Sem dependência do `vscode`. Os padrões cobrem formatos conhecidos de chave;
 * não pegam tudo, então isto reduz o risco, não o elimina.
 */

interface Pattern {
  type: string;
  regex: RegExp;
  /** Quando existe, só o grupo 2 é segredo (o grupo 1 é um rótulo que fica visível). */
  labelled?: boolean;
}

const PATTERNS: Pattern[] = [
  { type: "chave privada", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { type: "chave Anthropic", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: "chave OpenAI", regex: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { type: "chave xAI", regex: /xai-[A-Za-z0-9]{20,}/g },
  { type: "chave Google", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { type: "chave AWS", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "token GitHub", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "token GitHub", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { type: "token Slack", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "JWT", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: "token Bearer", regex: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi, labelled: true },
  {
    type: "valor secreto",
    // rótulo = valor, com valor de 12+ caracteres, com letra e dígito e sem parênteses
    // (para não confundir com chamadas de função)
    regex: /\b((?:api[_-]?key|secret|token|passw(?:or)?d|senha)\s*[:=]\s*["']?)((?=[^\s"'()]*[A-Za-z])(?=[^\s"'()]*\d)[^\s"'()]{12,})/gi,
    labelled: true,
  },
];

export interface SecretFinding {
  type: string;
  /** Linha (a partir de 1) em que o segredo começa. Nunca devolvemos o valor. */
  line: number;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/** Acha segredos no texto. Devolve só o tipo e a linha, nunca o valor. */
export function findSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  // Os padrões vão do mais específico ao mais geral: um trecho já reportado por um
  // padrão não é reportado de novo por outro (ex.: sk-ant-... também casa com sk-...).
  const covered: Array<[number, number]> = [];
  for (const { type, regex, labelled } of PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = labelled ? m.index + m[1].length : m.index;
      const end = m.index + m[0].length;
      if (!covered.some(([a, b]) => start < b && end > a)) {
        covered.push([start, end]);
        found.push({ type, line: lineOf(text, start) });
      }
      if (m[0].length === 0) {
        re.lastIndex++;
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Troca cada segredo por `[REDACTED:tipo]` (deixando visível o rótulo, quando há). */
export function redact(text: string): string {
  let out = text;
  for (const { type, regex, labelled } of PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    out = labelled
      ? out.replace(re, (_all, label: string) => `${label}[REDACTED:${type}]`)
      : out.replace(re, `[REDACTED:${type}]`);
  }
  return out;
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Redação em streaming. Os textos chegam em pedaços pequenos, e um segredo pode
 * ser cortado entre dois pedaços. Por isso só liberamos linhas completas, e
 * seguramos um bloco de chave privada aberto até ele fechar.
 */
export class StreamRedactor {
  private buf = "";
  private static readonly MAX_PARTIAL_LINE = 4000;

  /** Recebe um pedaço e devolve o que já pode ser mostrado, redigido. */
  push(chunk: string): string {
    this.buf += chunk;

    let cut = this.buf.lastIndexOf("\n") + 1;

    // Bloco de chave privada ainda aberto: segura tudo a partir da linha do BEGIN.
    let lastBegin = -1;
    for (const m of this.buf.matchAll(PRIVATE_KEY_BEGIN)) {
      lastBegin = m.index ?? -1;
    }
    if (lastBegin >= 0 && !PRIVATE_KEY_END.test(this.buf.slice(lastBegin))) {
      const lineStart = this.buf.lastIndexOf("\n", lastBegin) + 1;
      cut = Math.min(cut, lineStart);
    } else if (cut === 0 && this.buf.length > StreamRedactor.MAX_PARTIAL_LINE) {
      // Linha enorme sem quebra: libera até o último espaço para não segurar sem limite.
      cut = this.buf.lastIndexOf(" ") + 1;
    }

    if (cut <= 0) {
      return "";
    }
    const ready = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return redact(ready);
  }

  /** Libera o que sobrou (no fim da resposta). */
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    return redact(rest);
  }
}

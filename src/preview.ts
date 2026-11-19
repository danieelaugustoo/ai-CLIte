/**
 * Prévia do que será enviado (S7 e S18): um texto somente leitura com tudo o que
 * a extensão vai passar para a CLI. Sem dependência do `vscode`.
 */

export interface PreviewFile {
  path: string;
  chars: number;
}

export interface PreviewInput {
  engine: string;
  /** Vazio = modelo padrão da CLI. */
  model: string;
  cwdMode: "neutra" | "projeto";
  workspaceTrusted: boolean;
  args: string[];
  /** O texto exato que vai pelo stdin. */
  prompt: string;
  files: PreviewFile[];
  historyTurns: number;
  historyChars: number;
  selectionChars: number;
  notes: string[];
  /** Nomes (nunca valores) das variáveis de ambiente repassadas à CLI. */
  envNames: string[];
}

export const PREVIEW_START = "----- TEXTO EXATO ENVIADO PELO STDIN (começa na linha abaixo) -----";
export const PREVIEW_END = "----- FIM DO TEXTO ENVIADO -----";

/** Estimativa grosseira de tokens (1 token ≈ 4 caracteres). É só uma ordem de grandeza. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function buildPreview(i: PreviewInput): string {
  const lines: string[] = [];
  lines.push("CLITE-AI: O QUE VAI SER ENVIADO");
  lines.push("");
  lines.push(`Motor: ${i.engine}`);
  lines.push(`Modelo: ${i.model || "(o padrão da CLI)"}`);
  lines.push(
    i.cwdMode === "neutra"
      ? "Pasta de execução: temporária e vazia (a CLI não enxerga o seu projeto, nem o git status)"
      : "Pasta de execução: a do seu projeto (includeGitContext ligado: branch, autor e últimos commits vão junto)"
  );
  lines.push(`Workspace: ${i.workspaceTrusted ? "confiável" : "NÃO confiável (modo estrito)"}`);
  lines.push(`Argumentos da CLI: ${i.args.map((a) => (a === "" ? '""' : /\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
  lines.push("");
  const chars = i.prompt.length;
  lines.push(`Tamanho do texto enviado: ${chars} caracteres (cerca de ${estimateTokens(chars)} tokens, só uma estimativa)`);
  lines.push(`Seleção: ${i.selectionChars} caracteres`);
  lines.push(`Histórico: ${i.historyTurns} turno(s), ${i.historyChars} caracteres`);
  if (i.files.length === 0) {
    lines.push("Arquivos do contexto: nenhum");
  } else {
    lines.push(`Arquivos do contexto (${i.files.length}):`);
    for (const f of i.files) {
      lines.push(`  - ${f.path} (${f.chars} caracteres)`);
    }
  }
  lines.push(`Variáveis de ambiente repassadas à CLI (só os nomes): ${i.envNames.length ? i.envNames.join(", ") : "nenhuma"}`);
  for (const n of i.notes) {
    lines.push(n);
  }
  lines.push("");
  lines.push("Além disso, a própria CLI acrescenta instruções de sistema (alguns milhares de caracteres), a data e a plataforma.");
  lines.push("Quem recebe tudo isso é o provedor que a CLI usa, sob os termos dele.");
  lines.push("");
  lines.push(PREVIEW_START);
  lines.push(i.prompt);
  lines.push(PREVIEW_END);
  return lines.join("\n");
}

/** Extrai de volta o texto enviado (para os testes conferirem byte a byte). */
export function extractPromptFromPreview(preview: string): string | undefined {
  const start = preview.indexOf(PREVIEW_START);
  const end = preview.lastIndexOf(PREVIEW_END);
  if (start < 0 || end < 0 || end < start) {
    return undefined;
  }
  return preview.slice(start + PREVIEW_START.length + 1, end - 1);
}

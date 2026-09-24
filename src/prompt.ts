/**
 * Construção do texto que vai para o stdin da CLI.
 *
 * Ordem (do conteúdo mais estável para o mais variável):
 *   <contexto> (carrinho) → <historico> (memória) → <pedido> (instrução + seleção)
 * Cada secção só aparece se tiver conteúdo.
 */

import type { CartFile } from "./contextCart";
import type { Turn } from "./conversation";

// ---------------------------------------------------------------------------
// Pedido atual (movido da Fase 1 sem alterações)
// ---------------------------------------------------------------------------

export interface PromptParts {
  instruction: string;
  code: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  languageId: string;
}

/**
 * Concatena a instrução do utilizador com o código selecionado, usando uma
 * fence Markdown com backticks suficientes para não quebrar caso o próprio
 * código já contenha sequências de backticks.
 */
export function buildPrompt(parts: PromptParts): string {
  const fence = "`".repeat(longestBacktickRun(parts.code) + 1 + 3); // pelo menos 3, e sempre > que o maior run existente
  const lineRange =
    parts.startLine === parts.endLine
      ? `linha ${parts.startLine}`
      : `linhas ${parts.startLine}-${parts.endLine}`;

  return [
    parts.instruction,
    "",
    `Ficheiro: ${parts.relativePath} (${lineRange}) · linguagem: ${parts.languageId}`,
    `${fence}${parts.languageId}`,
    parts.code,
    fence,
  ].join("\n");
}

/** Devolve o comprimento da maior sequência consecutiva de backticks no texto. */
export function longestBacktickRun(text: string): number {
  const matches = text.match(/`+/g);
  if (!matches) {
    return 0;
  }
  return Math.max(...matches.map((m) => m.length));
}

// ---------------------------------------------------------------------------
// Prompt completo (Fase 2)
// ---------------------------------------------------------------------------

export interface FullPromptInput {
  /** Ficheiros do carrinho de contexto (já lidos). */
  files: CartFile[];
  /** Turnos anteriores da conversa (vazio numa "nova pergunta"). */
  turns: Turn[];
  /** Pedido atual: saída de buildPrompt(), ou só a instrução num seguimento sem seleção. */
  request: string;
  /** Há um alvo (seleção atual ou da conversa) onde um diff poderá ser aplicado? */
  hasTarget: boolean;
}

/** Instrução final que torna o diff fiável: o trecho devolvido completo, num único bloco. */
const PROPOSAL_RULE =
  "Se propuseres alterações ao código selecionado, devolve a versão completa desse trecho num único bloco de código.";

export function buildFullPrompt(input: FullPromptInput): string {
  const sections: string[] = [];

  if (input.files.length > 0) {
    const blocks = input.files.map((f) => {
      const fence = fenceFor(f.content);
      const attr = f.path.replace(/"/g, "&quot;");
      return `<ficheiro caminho="${attr}">\n${fence}${f.lang}\n${f.content}\n${fence}\n</ficheiro>`;
    });
    sections.push(`<contexto>\n${blocks.join("\n")}\n</contexto>`);
  }

  if (input.turns.length > 0) {
    const blocks = input.turns.map(
      (t) => `<turno>\n<pergunta>${t.request}</pergunta>\n<resposta>${t.response}</resposta>\n</turno>`
    );
    sections.push(`<historico>\n${blocks.join("\n")}\n</historico>`);
  }

  sections.push(`<pedido>\n${input.request}\n</pedido>`);

  if (input.hasTarget) {
    sections.push(PROPOSAL_RULE);
  }

  return sections.join("\n\n");
}

/** Fence com mais backticks do que qualquer sequência existente no conteúdo (mínimo 3). */
function fenceFor(content: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
}

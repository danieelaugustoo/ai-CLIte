/**
 * Construção do texto que vai para o stdin da CLI.
 *
 * Ordem (do conteúdo mais estável para o mais variável):
 *   <contexto> (carrinho) → <historico> (memória) → <pedido> (instrução + seleção)
 * Cada secção só aparece se tiver conteúdo.
 */

import { randomBytes } from "crypto";
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
  /** Sufixo dos delimitadores. Só para testes: em uso normal é sorteado a cada pedido. */
  nonce?: string;
}

/** Instrução final que torna o diff fiável: o trecho devolvido completo, num único bloco. */
const PROPOSAL_RULE =
  "Se propuseres alterações ao código selecionado, devolve a versão completa desse trecho num único bloco de código.";

/**
 * Sorteia um sufixo para os delimitadores que não apareça em nenhum dos textos.
 * Assim um arquivo ou uma resposta antiga com `</contexto>` ou `</pedido>` não
 * consegue fechar uma seção e fingir ser outra (S12).
 */
export function newNonce(texts: string[]): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const nonce = randomBytes(6).toString("hex");
    if (!texts.some((t) => t.includes(nonce))) {
      return nonce;
    }
  }
  throw new Error("não foi possível gerar um delimitador único para o prompt");
}

/** Escapa um valor para ir dentro de um atributo entre aspas. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildFullPrompt(input: FullPromptInput): string {
  const nonce =
    input.nonce ??
    newNonce([
      input.request,
      ...input.files.flatMap((f) => [f.path, f.content]),
      ...input.turns.flatMap((t) => [t.request, t.response]),
    ]);
  const tag = (name: string): string => `${name}_${nonce}`;
  const sections: string[] = [];

  if (input.files.length > 0) {
    const blocks = input.files.map((f) => {
      const fence = fenceFor(f.content);
      const attr = escapeAttribute(f.path);
      return `<${tag("ficheiro")} caminho="${attr}">\n${fence}${f.lang}\n${f.content}\n${fence}\n</${tag("ficheiro")}>`;
    });
    sections.push(`<${tag("contexto")}>\n${blocks.join("\n")}\n</${tag("contexto")}>`);
  }

  if (input.turns.length > 0) {
    const blocks = input.turns.map(
      (t) =>
        `<${tag("turno")}>\n<${tag("pergunta")}>${t.request}</${tag("pergunta")}>\n<${tag("resposta")}>${t.response}</${tag("resposta")}>\n</${tag("turno")}>`
    );
    sections.push(`<${tag("historico")}>\n${blocks.join("\n")}\n</${tag("historico")}>`);
  }

  sections.push(`<${tag("pedido")}>\n${input.request}\n</${tag("pedido")}>`);

  if (input.hasTarget) {
    sections.push(PROPOSAL_RULE);
  }

  return sections.join("\n\n");
}

/** Fence com mais backticks do que qualquer sequência existente no conteúdo (mínimo 3). */
function fenceFor(content: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
}

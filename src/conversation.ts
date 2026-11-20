/**
 * Memória leve da conversa.
 *
 * Tudo vive em memória no processo da extensão: não usa --resume nem sessões
 * da CLI. Perde-se ao recarregar a janela (intencional). O histórico guarda só
 * pedido e resposta — NUNCA o conteúdo do carrinho de contexto, que é enviado
 * à parte em cada pedido.
 */

import * as vscode from "vscode";

export interface Turn {
  /** Saída do buildPrompt() (instrução + seleção), sem ficheiros do carrinho. */
  request: string;
  response: string;
}

/** Trecho do ficheiro onde uma proposta de código poderá ser aplicada. */
export interface Target {
  uri: vscode.Uri;
  range: vscode.Range;
  /** Texto que estava no intervalo quando o pedido foi feito (para relocalizar). */
  originalText: string;
  eol: vscode.EndOfLine;
}

let turns: Turn[] = [];
let target: Target | undefined;
let onChange: () => void = () => {};

/** Regista o callback chamado sempre que o estado muda (barra de estado). */
export function setOnChange(cb: () => void): void {
  onChange = cb;
}

export function getTurns(): Turn[] {
  return turns;
}

export function getTarget(): Target | undefined {
  return target;
}

/** Começa uma conversa nova (descarta o histórico anterior). */
export function startNew(turn: Turn, newTarget?: Target): void {
  turns = [turn];
  target = newTarget;
  trim();
  onChange();
}

/** Acrescenta um turno; o alvo só muda se for indicado um novo. */
export function append(turn: Turn, newTarget?: Target): void {
  turns.push(turn);
  if (newTarget) {
    target = newTarget;
  }
  trim();
  onChange();
}

export function clear(): void {
  turns = [];
  target = undefined;
  onChange();
}

/** Nº de turnos e total de caracteres do histórico (para mostrar antes de gastar tokens). */
export function summary(): { turns: number; chars: number } {
  return {
    turns: turns.length,
    chars: turns.reduce((sum, t) => sum + t.request.length + t.response.length, 0),
  };
}

/** Aplica os limites das definições, descartando primeiro os turnos mais antigos. */
function trim(): void {
  const config = vscode.workspace.getConfiguration("cliteAi");
  const maxTurns = Math.max(1, config.get<number>("historyMaxTurns", 3));
  const maxChars = config.get<number>("historyMaxChars", 20000);

  while (turns.length > maxTurns) {
    turns.shift();
  }
  // Mantém sempre pelo menos o último turno, mesmo que sozinho passe o limite.
  while (turns.length > 1 && summary().chars > maxChars) {
    turns.shift();
  }
}

/**
 * Carrinho de contexto: ficheiros escolhidos pelo utilizador para acompanharem
 * os pedidos. Só guardamos URIs; o conteúdo é lido no momento do envio, por
 * isso apanha sempre a versão atual (incluindo alterações ainda não gravadas).
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { describeReadError, findHiddenChars, isInsideAny, isSensitivePath } from "./cartPolicy";
import { findSecrets } from "./secrets";

export interface CartFile {
  /** Caminho relativo ao workspace. */
  path: string;
  lang: string;
  content: string;
}

const files = new Map<string, vscode.Uri>();
let onChange: () => void = () => {};

/** Regista o callback chamado sempre que o carrinho muda (barra de estado). */
export function setOnChange(cb: () => void): void {
  onChange = cb;
}

export function count(): number {
  return files.size;
}

/** Pergunta (modal) antes de incluir algo arriscado. Devolve true só se o usuário confirmar. */
async function confirmRisk(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Adicionar mesmo assim");
  return choice === "Adicionar mesmo assim";
}

function realpathOrSame(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Dentro de alguma pasta do workspace, seguindo links simbólicos (um link para fora conta como fora). */
function isInsideWorkspace(file: vscode.Uri): boolean {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => realpathOrSame(f.uri.fsPath));
  return isInsideAny(realpathOrSame(file.fsPath), roots);
}

/**
 * Comando "Adicionar ao contexto". Os menus do explorador passam
 * (uriClicado, urisSelecionados[]); sem argumentos (Command Palette) usa-se
 * o ficheiro do editor ativo.
 */
export async function addToContext(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const candidates =
    uris && uris.length > 0 ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];

  if (candidates.length === 0) {
    vscode.window.showWarningMessage("Claude CLI Lite: nenhum ficheiro para adicionar.");
    return;
  }

  let added = 0;
  for (const u of candidates) {
    if (u.scheme === "file") {
      try {
        const stat = await vscode.workspace.fs.stat(u);
        if (stat.type & vscode.FileType.Directory) {
          vscode.window.showWarningMessage(`Claude CLI Lite: "${vscode.workspace.asRelativePath(u, false)}" é uma pasta; escolhe ficheiros.`);
          continue;
        }
      } catch {
        vscode.window.showWarningMessage(`Claude CLI Lite: não foi possível ler "${u.fsPath}".`);
        continue;
      }
    }
    if (u.scheme === "file") {
      const rel = vscode.workspace.asRelativePath(u, false);
      if (isSensitivePath(u.fsPath) && !(await confirmRisk(`"${rel}" parece conter segredos (pelo nome ou pela pasta). Adicionar ao contexto mesmo assim?`))) {
        continue;
      }
      if (!isInsideWorkspace(u) && !(await confirmRisk(`"${rel}" está fora das pastas do workspace. Adicionar ao contexto mesmo assim?`))) {
        continue;
      }
    }
    if (!files.has(u.toString())) {
      files.set(u.toString(), u);
      added++;
    }
  }

  onChange();
  if (added > 0) {
    vscode.window.setStatusBarMessage(`Claude CLI Lite: ${added} ficheiro(s) adicionado(s) ao contexto (${files.size} no total).`, 4000);
  }
}

/** Quick Pick com todos os ficheiros pré-selecionados; os desmarcados saem do carrinho. */
export async function manageContext(): Promise<void> {
  if (files.size === 0) {
    vscode.window.showInformationMessage("Claude CLI Lite: o contexto está vazio.");
    return;
  }

  const items: (vscode.QuickPickItem & { key: string })[] = [];
  for (const [key, uri] of files) {
    let description = "";
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      description = `${doc.getText().length} caracteres`;
    } catch {
      description = "não legível";
    }
    items.push({ key, label: vscode.workspace.asRelativePath(uri, false), description, picked: true });
  }

  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: "Desmarca os ficheiros que queres retirar do contexto",
  });
  if (!chosen) {
    return; // Esc: não altera nada
  }

  const keep = new Set(chosen.map((i) => i.key));
  for (const key of [...files.keys()]) {
    if (!keep.has(key)) {
      files.delete(key);
    }
  }
  onChange();
}

export function clearContext(): void {
  files.clear();
  onChange();
}

/**
 * Lê o conteúdo atual dos ficheiros do carrinho. Ficheiros binários ou que já
 * não existem são ignorados (os inexistentes saem do carrinho); os avisos vão
 * em `notes` para o chamador os escrever no canal de output.
 */
export async function readCart(): Promise<{ files: CartFile[]; notes: string[] }> {
  const result: CartFile[] = [];
  const notes: string[] = [];
  let removed = false;

  for (const [key, uri] of [...files]) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    try {
      // openTextDocument apanha alterações não gravadas e resolve o encoding.
      const doc = await vscode.workspace.openTextDocument(uri);
      const content = doc.getText();
      if (content.includes("\0")) {
        notes.push(`[contexto] "${rel}" parece binário; ignorado.`);
        continue;
      }
      result.push({ path: rel, lang: doc.languageId, content });
    } catch (err) {
      // Só some do carrinho o que realmente não existe mais; os outros erros são avisados.
      const info = describeReadError(err);
      if (info.kind === "missing") {
        files.delete(key);
        removed = true;
        notes.push(`[contexto] "${rel}" já não existe; removido do carrinho.`);
      } else {
        notes.push(`[contexto] não foi possível ler "${rel}" (${info.detail}); ele continua no carrinho, mas não foi enviado.`);
      }
    }
  }

  if (removed) {
    onChange();
  }
  return { files: result, notes };
}

export function totalChars(list: CartFile[]): number {
  return list.reduce((sum, f) => sum + f.content.length, 0);
}

/** Pede confirmação (modal) se o contexto passar o limite. Devolve false se o utilizador cancelar. */
export async function confirmSize(list: CartFile[]): Promise<boolean> {
  const max = vscode.workspace.getConfiguration("claudeCliLite").get<number>("contextMaxChars", 60000);
  const total = totalChars(list);
  if (total <= max) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    `O contexto tem ~${total} caracteres (limite configurado: ${max}). Enviar?`,
    { modal: true },
    "Enviar"
  );
  return choice === "Enviar";
}

/**
 * Antes de enviar: procura possíveis segredos e caracteres ocultos (bidi, invisíveis)
 * nos arquivos do contexto e na seleção. Mostra só o tipo e a linha, nunca o valor.
 * Devolve false se o usuário cancelar.
 */
export async function confirmFindings(list: CartFile[], selectedText: string): Promise<boolean> {
  const lines: string[] = [];
  const check = (label: string, text: string): void => {
    for (const f of findSecrets(text)) {
      lines.push(`• ${label}, linha ${f.line}: ${f.type}`);
    }
    for (const h of findHiddenChars(text)) {
      lines.push(`• ${label}, linha ${h.line}: caractere ${h.kind}`);
    }
  };
  for (const f of list) {
    check(f.path, f.content);
  }
  if (selectedText) {
    check("seleção", selectedText);
  }
  if (lines.length === 0) {
    return true;
  }
  const shown = lines.slice(0, 10).join("\n") + (lines.length > 10 ? `\n… e mais ${lines.length - 10}` : "");
  const choice = await vscode.window.showWarningMessage(
    `Encontrei possíveis segredos ou caracteres ocultos no que vai ser enviado:\n${shown}\n\nEnviar mesmo assim?`,
    { modal: true },
    "Enviar mesmo assim"
  );
  return choice === "Enviar mesmo assim";
}

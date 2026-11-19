/**
 * Propostas de código do Claude: extração dos blocos da resposta, diff visual
 * (documento virtual `clite-ai-proposal`) e rotinas Apply / Discard.
 *
 * Nada abre sozinho: o utilizador é avisado e decide se quer ver o diff.
 */

import * as vscode from "vscode";
import type { Target } from "./conversation";

const SCHEME = "clite-ai-proposal";

export interface CodeBlock {
  lang: string;
  code: string;
}

interface Pending {
  target: Target;
  blocks: CodeBlock[];
  /** Bloco escolhido para o diff (undefined até o utilizador escolher). */
  chosen?: CodeBlock;
  /** URI do documento virtual atualmente aberto no diff. */
  diffUri?: vscode.Uri;
}

/** Única proposta pendente. */
let pending: Pending | undefined;

// ---------------------------------------------------------------------------
// Extração de blocos de código
// ---------------------------------------------------------------------------

/**
 * Extrai blocos Markdown de código. Aceita fences de 3 ou mais backticks e só
 * fecha com a mesma fence (assim blocos com ``` dentro de ```` funcionam).
 * Corre sobre o texto COMPLETO, depois do `close`, para nunca apanhar blocos cortados.
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const regex = /^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1[ \t]*$/gm;
  const blocks: CodeBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ lang: match[2].trim(), code: match[3] });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Relocalização do trecho e cálculo do texto proposto
// ---------------------------------------------------------------------------

/**
 * Encontra onde está agora o trecho original. Primeiro tenta o intervalo
 * guardado; se o ficheiro mudou, procura o texto original e só aceita se
 * houver UMA única ocorrência (senão não é seguro aplicar).
 */
function resolveRange(doc: vscode.TextDocument, target: Target): vscode.Range | undefined {
  if (doc.getText(target.range) === target.originalText) {
    return target.range;
  }
  if (target.originalText.length === 0) {
    return undefined;
  }
  const full = doc.getText();
  const first = full.indexOf(target.originalText);
  if (first === -1 || full.indexOf(target.originalText, first + 1) !== -1) {
    return undefined;
  }
  return new vscode.Range(doc.positionAt(first), doc.positionAt(first + target.originalText.length));
}

/** Normaliza o código proposto para o EOL do documento e preserva a quebra final do trecho original. */
function normalizeCode(code: string, doc: vscode.TextDocument, originalText: string): string {
  const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  let result = code.replace(/\r\n|\n/g, eol);
  // Se a seleção original terminava numa quebra de linha (ex.: linhas inteiras),
  // o bloco extraído perdeu-a; sem isto a linha seguinte colava-se ao código novo.
  if (/\n$/.test(originalText) && !/\n$/.test(result)) {
    result += eol;
  }
  return result;
}

/** Texto completo do ficheiro com o trecho substituído pelo código proposto. */
function buildProposedText(doc: vscode.TextDocument, range: vscode.Range, code: string): string {
  const full = doc.getText();
  return full.slice(0, doc.offsetAt(range.start)) + code + full.slice(doc.offsetAt(range.end));
}

// ---------------------------------------------------------------------------
// Documento virtual (lado direito do diff)
// ---------------------------------------------------------------------------

/**
 * Provedor de conteúdo do esquema `clite-ai-proposal`. Em vez de guardar um
 * texto fixo, abre o documento alvo (versão viva, incluindo alterações não
 * gravadas) e devolve-o com o trecho substituído. A URI mantém o caminho do
 * ficheiro real, por isso o editor aplica o syntax highlighting correto.
 */
class ProposalProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(): Promise<string> {
    if (!pending || !pending.chosen) {
      return "";
    }
    const doc = await vscode.workspace.openTextDocument(pending.target.uri);
    const range = resolveRange(doc, pending.target);
    if (!range) {
      return doc.getText();
    }
    const code = normalizeCode(pending.chosen.code, doc, pending.target.originalText);
    return buildProposedText(doc, range, code);
  }
}

let onChange: () => void = () => {};

/** Regista o callback chamado quando a proposta pendente muda (barra de estado). */
export function setOnChange(cb: () => void): void {
  onChange = cb;
}

export function register(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ProposalProvider()));
  setHasProposal(false);
}

export function hasProposal(): boolean {
  return pending !== undefined;
}

/** Context key usada nos menus (botões ✓/✕ e Command Palette). */
function setHasProposal(value: boolean): void {
  vscode.commands.executeCommand("setContext", "cliteAi.hasProposal", value);
  onChange();
}

// ---------------------------------------------------------------------------
// Fluxo: oferecer, ver, aplicar, descartar
// ---------------------------------------------------------------------------

/**
 * Chamado depois de uma resposta bem-sucedida. Substitui qualquer proposta
 * anterior. Só avisa se houver blocos de código E um alvo; nunca abre o diff sozinho.
 */
export async function offerProposal(responseText: string, target: Target | undefined): Promise<void> {
  await clearPending();

  const blocks = extractCodeBlocks(responseText);
  if (blocks.length === 0 || !target) {
    return;
  }

  pending = { target, blocks };
  setHasProposal(true);

  // Não esperamos pelo clique: o aviso pode ficar aberto indefinidamente.
  vscode.window
    .showInformationMessage(`O Claude propôs código (${blocks.length} ${blocks.length === 1 ? "bloco" : "blocos"}).`, "Ver diff")
    .then((choice) => {
      if (choice === "Ver diff") {
        showProposal();
      }
    });
}

/** Abre o diff da proposta pendente (escolhendo o bloco, se houver vários). */
export async function showProposal(): Promise<void> {
  if (!pending) {
    vscode.window.showInformationMessage("CLIte-ai: não há alterações propostas.");
    return;
  }

  if (!pending.chosen) {
    if (pending.blocks.length === 1) {
      pending.chosen = pending.blocks[0];
    } else {
      const items = pending.blocks.map((b, i) => {
        const lines = b.code.split("\n");
        return {
          label: `${b.lang || "texto"}: ${lines[0].trim().slice(0, 60) || "(linha vazia)"}`,
          description: `${lines.length} linha(s)`,
          block: b,
          index: i,
        };
      });
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Que bloco queres comparar com o teu código?" });
      if (!picked) {
        return;
      }
      pending.chosen = picked.block;
    }
  }

  const { target } = pending;
  const doc = await vscode.workspace.openTextDocument(target.uri);
  if (!resolveRange(doc, target)) {
    vscode.window.showErrorMessage("CLIte-ai: o trecho original mudou; não é seguro mostrar/aplicar a proposta.");
    return;
  }

  // A query única evita que o editor reutilize conteúdo em cache de propostas anteriores.
  const proposalUri = vscode.Uri.from({ scheme: SCHEME, path: target.uri.path, query: String(Date.now()) });
  pending.diffUri = proposalUri;
  const name = target.uri.path.split("/").pop() ?? "ficheiro";
  await vscode.commands.executeCommand("vscode.diff", target.uri, proposalUri, `CLIte-ai: ${name} ↔ proposta`);
}

/** Aplica a proposta ao ficheiro real (sem gravar) e limpa o estado. */
export async function applyProposal(): Promise<void> {
  if (!pending || !pending.chosen) {
    vscode.window.showInformationMessage("CLIte-ai: não há alterações propostas para aplicar.");
    return;
  }
  const { target, chosen } = pending;

  const doc = await vscode.workspace.openTextDocument(target.uri);
  const range = resolveRange(doc, target);
  if (!range) {
    vscode.window.showErrorMessage("CLIte-ai: o trecho original mudou; não é seguro aplicar.");
    return;
  }

  // WorkspaceEdit.replace aplica a alteração como uma edição normal do editor:
  // fica "dirty" (por gravar) e Ctrl+Z desfaz. Não gravamos nós.
  const code = normalizeCode(chosen.code, doc, target.originalText);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(target.uri, range, code);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage("CLIte-ai: não foi possível aplicar as alterações.");
    return;
  }

  // Depois do edit, o documento vivo já tem o código novo: o novo intervalo
  // começa onde o antigo começava e tem o tamanho do código inserido.
  // Mutamos o alvo (partilhado com a conversa) para os seguimentos apontarem para o código atual.
  const start = range.start;
  target.range = new vscode.Range(start, doc.positionAt(doc.offsetAt(start) + code.length));
  target.originalText = code;

  await clearPending();
  await vscode.window.showTextDocument(doc);
}

export async function discardProposal(): Promise<void> {
  if (!pending) {
    return;
  }
  await clearPending();
  vscode.window.setStatusBarMessage("CLIte-ai: alterações descartadas.", 3000);
}

/** Limpa a proposta pendente e fecha o separador do diff, se estiver aberto. */
async function clearPending(): Promise<void> {
  const diffUri = pending?.diffUri;
  pending = undefined;
  setHasProposal(false);

  if (!diffUri) {
    return;
  }
  // Fechamos o separador certo pela URI (e não o "editor ativo"), para nunca
  // fechar outro ficheiro por engano quando o comando vem da Command Palette.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === diffUri.toString()) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}

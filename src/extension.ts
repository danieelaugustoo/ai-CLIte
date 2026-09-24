/**
 * Claude CLI Lite
 * ----------------
 * Ponte leve e "burra" entre o editor e a instalação global do Claude Code (CLI).
 *
 * A extensão NÃO tem inteligência própria, NÃO importa SDKs de IA e NÃO gere
 * chaves de API. Tudo o que faz é:
 *   1. Ler a seleção ativa do editor.
 *   2. Perguntar ao utilizador qual é a instrução.
 *   3. Invocar `claude -p` (processo filho) passando o prompt via stdin.
 *   4. Ler o stream de eventos JSON da CLI e escrever o texto, em tempo real,
 *      num OutputChannel nativo do VS Code.
 *
 * Isto evita o "contexto fantasma" (árvore de ficheiros inteira, ficheiros
 * completos) que a integração nativa do Claude injeta a cada mensagem.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcessWithoutNullStreams, exec } from "child_process";
import { buildPrompt, buildFullPrompt } from "./prompt";
import * as conversation from "./conversation";
import * as cart from "./contextCart";
import * as proposal from "./proposal";

// ---------------------------------------------------------------------------
// Estado do módulo
// ---------------------------------------------------------------------------

/** Canal de output onde a resposta da CLI é escrita em streaming. */
let outputChannel: vscode.OutputChannel;

/** Processo atualmente em execução (só um pedido de cada vez). */
let currentProcess: ChildProcessWithoutNullStreams | undefined;

/** Marca que o pedido em curso foi cancelado (comando ou botão da notificação). */
let cancelRequested = false;

/** Barra de estado: nº de turnos na memória e de ficheiros no carrinho. */
let statusBar: vscode.StatusBarItem;

// ---------------------------------------------------------------------------
// Ativação / desativação
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Claude CLI Lite");
  context.subscriptions.push(outputChannel);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "claudeCliLite.statusMenu";
  context.subscriptions.push(statusBar);

  // Os módulos avisam-nos quando o estado muda, para refrescarmos a barra.
  conversation.setOnChange(updateStatusBar);
  cart.setOnChange(updateStatusBar);
  proposal.setOnChange(updateStatusBar);
  proposal.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCliLite.askSelection", () => ask("new")),
    vscode.commands.registerCommand("claudeCliLite.continueConversation", () => ask("continue")),
    vscode.commands.registerCommand("claudeCliLite.clearConversation", clearConversation),
    vscode.commands.registerCommand("claudeCliLite.addToContext", cart.addToContext),
    vscode.commands.registerCommand("claudeCliLite.manageContext", cart.manageContext),
    vscode.commands.registerCommand("claudeCliLite.clearContext", cart.clearContext),
    vscode.commands.registerCommand("claudeCliLite.showProposal", proposal.showProposal),
    vscode.commands.registerCommand("claudeCliLite.applyProposal", proposal.applyProposal),
    vscode.commands.registerCommand("claudeCliLite.discardProposal", proposal.discardProposal),
    vscode.commands.registerCommand("claudeCliLite.statusMenu", statusMenu),
    vscode.commands.registerCommand("claudeCliLite.cancel", cancelCurrent)
  );

  updateStatusBar();
}

export function deactivate(): void {
  // Não deixar processos órfãos quando a extensão é desativada / o editor fecha.
  if (currentProcess) {
    killTree(currentProcess);
    currentProcess = undefined;
  }
}

// ---------------------------------------------------------------------------
// Comandos principais: "Nova pergunta" e "Continuar conversa"
// ---------------------------------------------------------------------------

/** Formata um nº de caracteres de forma curta (ex.: 14k). */
function formatChars(n: number): string {
  return n < 1000 ? String(n) : `${Math.round(n / 1000)}k`;
}

/**
 * Fluxo partilhado pelos dois comandos.
 *  - "new":      exige seleção; envia carrinho + pedido, SEM histórico.
 *  - "continue": envia carrinho + histórico + pedido; a seleção é opcional.
 * O histórico e a proposta de diff só são atualizados se o pedido tiver sucesso.
 */
async function ask(mode: "new" | "continue"): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.selection;
  const selectedText = editor && selection ? editor.document.getText(selection) : "";
  const hasSelection = selectedText.trim().length > 0;

  if (mode === "new") {
    if (!editor) {
      vscode.window.showWarningMessage("Claude CLI Lite: nenhum editor ativo.");
      return;
    }
    if (!hasSelection) {
      vscode.window.showWarningMessage("Claude CLI Lite: seleciona algum código primeiro.");
      return;
    }
  } else if (!hasSelection && conversation.getTurns().length === 0) {
    vscode.window.showWarningMessage("Claude CLI Lite: não há conversa; usa \"Nova pergunta sobre seleção\".");
    return;
  }

  if (currentProcess) {
    vscode.window.showWarningMessage(
      "Claude CLI Lite: já há um pedido em curso. Cancela-o (Claude: Cancelar pedido) antes de iniciar outro."
    );
    return;
  }

  // Alvo do diff: a seleção atual, ou (num seguimento sem seleção) o alvo da conversa.
  let target: conversation.Target | undefined;
  if (editor && selection && hasSelection) {
    target = {
      uri: editor.document.uri,
      range: new vscode.Range(selection.start, selection.end),
      originalText: selectedText,
      eol: editor.document.eol,
    };
  } else if (mode === "continue") {
    target = conversation.getTarget();
  }

  const turns = mode === "continue" ? conversation.getTurns() : [];

  // Transparência antes de gastar tokens: mostra quanto vai ser enviado.
  const preview = await cart.readCart();
  const historyChars = turns.reduce((sum, t) => sum + t.request.length + t.response.length, 0);
  const previewChars = cart.totalChars(preview.files) + historyChars + selectedText.length;
  const summaryLine = `Contexto: ${turns.length} turnos · ${preview.files.length} ficheiros · ~${formatChars(previewChars)} caracteres`;

  const instruction = await vscode.window.showInputBox({
    prompt: `O que queres pedir ao Claude? (${summaryLine})`,
    placeHolder: "ex.: Refatore isto / Encontre o bug / Explique",
    ignoreFocusOut: true,
  });

  // InputBox cancelada (Esc) devolve undefined; vazia devolve string vazia.
  if (!instruction || instruction.trim().length === 0) {
    return;
  }

  // Pedido atual: com seleção leva o bloco de código; sem seleção é só a instrução.
  let request = instruction;
  let cwdUri: vscode.Uri | undefined = target?.uri;
  if (editor && selection && hasSelection) {
    const document = editor.document;
    request = buildPrompt({
      instruction,
      code: selectedText,
      relativePath: vscode.workspace.asRelativePath(document.uri, false),
      startLine: selection.start.line + 1, // 1-indexed para leitura humana
      endLine: selection.end.line + 1,
      languageId: document.languageId,
    });
    cwdUri = document.uri;
  }

  // Lemos o carrinho outra vez, imediatamente antes de enviar (o utilizador pode ter editado ficheiros).
  const cartNow = await cart.readCart();
  if (!(await cart.confirmSize(cartNow.files))) {
    return;
  }

  const prompt = buildFullPrompt({ files: cartNow.files, turns, request, hasTarget: target !== undefined });
  const cwd = cwdUri ? resolveCwd(cwdUri) : os.homedir();

  const result = await runClaude(prompt, cwd, [...cartNow.notes, summaryLine]);
  if (!result.ok) {
    return; // falha ou cancelamento: histórico e proposta anteriores ficam intactos
  }

  const turn = { request, response: result.text };
  if (mode === "new") {
    conversation.startNew(turn, target);
  } else {
    conversation.append(turn, target);
  }
  await proposal.offerProposal(result.text, target);
}

function clearConversation(): void {
  conversation.clear();
  vscode.window.showInformationMessage("Claude CLI Lite: conversa limpa.");
}

function cancelCurrent(): void {
  if (!currentProcess) {
    vscode.window.showInformationMessage("Claude CLI Lite: não há nenhum pedido em curso.");
    return;
  }
  cancelRequested = true;
  // A mensagem "[cancelado pelo utilizador]" é escrita no `close` do processo (runClaude),
  // para aparecer também quando se cancela pelo botão da notificação.
  killTree(currentProcess);
  currentProcess = undefined;
}

// ---------------------------------------------------------------------------
// Barra de estado e menu de estado
// ---------------------------------------------------------------------------

function updateStatusBar(): void {
  const turns = conversation.getTurns().length;
  const files = cart.count();
  if (turns === 0 && files === 0) {
    statusBar.hide();
    return;
  }
  statusBar.text = `$(comment-discussion) ${turns}  $(file) ${files}`;
  statusBar.tooltip = `Claude CLI Lite: ${turns} turno(s) na conversa · ${files} ficheiro(s) no contexto`;
  statusBar.show();
}

async function statusMenu(): Promise<void> {
  const items: (vscode.QuickPickItem & { command: string })[] = [
    { label: "Continuar conversa", command: "claudeCliLite.continueConversation" },
    { label: "Limpar conversa", command: "claudeCliLite.clearConversation" },
    { label: "Gerir contexto", command: "claudeCliLite.manageContext" },
    { label: "Limpar contexto", command: "claudeCliLite.clearContext" },
  ];
  if (proposal.hasProposal()) {
    items.push({ label: "Ver alterações propostas", command: "claudeCliLite.showProposal" });
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Claude CLI Lite" });
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}

// ---------------------------------------------------------------------------
// Construção dos argumentos da CLI (modo "cirúrgico")
// ---------------------------------------------------------------------------

function buildArgs(): string[] {
  const config = vscode.workspace.getConfiguration("claudeCliLite");
  const model = config.get<string>("model", "").trim();
  const extraArgs = config.get<string[]>("extraArgs", []);

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--strict-mcp-config",
    // --strict-mcp-config não bloqueia os conectores do claude.ai (ex.: Claude Docs),
    // que carregariam ferramentas e gastariam tokens em cada pedido.
    "--disallowedTools",
    "mcp__*",
    "--no-session-persistence",
  ];

  if (model) {
    args.push("--model", model);
  }

  return [...args, ...extraArgs];
}

/** Diretório de trabalho do processo: pasta do workspace do ficheiro, ou home. */
function resolveCwd(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? folder.uri.fsPath : os.homedir();
}

// ---------------------------------------------------------------------------
// Execução da CLI com streaming
// ---------------------------------------------------------------------------

/** Formato (parcial) dos eventos que a CLI emite com --output-format stream-json. */
interface StreamJsonLine {
  type?: string;
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
  };
  is_error?: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
}

/** Resultado de um pedido: `ok` só é true com exit 0, sem cancelamento e sem is_error. */
interface RunResult {
  ok: boolean;
  /** Texto completo da resposta (deltas acumulados, ou o `result` como fallback). */
  text: string;
}

/** Estado acumulado durante o parse do stream. */
interface StreamState {
  receivedAnyDelta: boolean;
  text: string;
  isError: boolean;
}

/** `headerLines` são escritas no canal antes do comando (resumo do contexto, avisos do carrinho). */
async function runClaude(prompt: string, cwd: string, headerLines: string[] = []): Promise<RunResult> {
  const config = vscode.workspace.getConfiguration("claudeCliLite");
  const cliPath = config.get<string>("cliPath", "claude").trim() || "claude";
  const args = buildArgs();

  cancelRequested = false;
  outputChannel.clear();
  outputChannel.show(true);
  for (const line of headerLines) {
    outputChannel.appendLine(line);
  }
  outputChannel.appendLine(`$ ${cliPath} ${args.map(quoteForDisplay).join(" ")}`);
  outputChannel.appendLine("");

  return vscode.window.withProgress<RunResult>(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Claude CLI Lite",
      cancellable: true,
    },
    (progress, cancellationToken) => {
      progress.report({ message: "a perguntar ao Claude…" });

      return new Promise<RunResult>((resolve) => {
        // No Windows o binário instalado pelo npm é um shim `.cmd`. Desde as
        // versões recentes do Node, invocar um `.cmd` sem `shell: true`
        // lança EINVAL — por isso usamos shell apenas em win32.
        const useShell = process.platform === "win32";

        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(cliPath, args, {
            cwd,
            shell: useShell,
            windowsHide: true, // evita que o cmd.exe (shell:true) abra uma janela de consola
            env: { ...process.env, NO_COLOR: "1" },
          });
        } catch (err: any) {
          reportSpawnFailure(err, cliPath);
          resolve({ ok: false, text: "" });
          return;
        }

        currentProcess = child;

        cancellationToken.onCancellationRequested(() => {
          cancelRequested = true;
          if (currentProcess === child) {
            killTree(child);
            currentProcess = undefined;
          }
        });

        let stdoutBuffer = "";
        let stderrBuffer = "";
        const state: StreamState = { receivedAnyDelta: false, text: "", isError: false };
        let spawnFailed = false;

        child.stdout.setEncoding("utf8"); // evita cortar caracteres multi-byte entre chunks
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk: string) => {
          stdoutBuffer += chunk;
          let newlineIndex: number;
          while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
            const line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            if (line.trim().length > 0) {
              handleStreamLine(line, state);
            }
          }
        });

        child.stderr.on("data", (chunk: string) => {
          stderrBuffer += chunk;
          outputChannel.append(`[stderr] ${chunk}`);
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
          spawnFailed = true;
          reportSpawnFailure(err, cliPath);
        });

        child.on("close", (code) => {
          if (currentProcess === child) {
            currentProcess = undefined;
          }
          if (spawnFailed) {
            resolve({ ok: false, text: "" });
            return;
          }

          // Processa qualquer resto sem newline final.
          if (stdoutBuffer.trim().length > 0) {
            handleStreamLine(stdoutBuffer, state);
            stdoutBuffer = "";
          }

          // Cancelado pelo comando ou pelo botão da notificação: não é um erro.
          if (cancelRequested || cancellationToken.isCancellationRequested) {
            outputChannel.appendLine("\n\n[cancelado pelo utilizador]");
            resolve({ ok: false, text: state.text });
            return;
          }

          if (code !== 0) {
            outputChannel.appendLine(`\n[processo terminou com código ${code}]`);
            vscode.window.showErrorMessage(
              `Claude CLI Lite: a CLI terminou com código ${code}. Vê o canal "Claude CLI Lite" para detalhes.`
            );
          }

          resolve({ ok: code === 0 && !state.isError, text: state.text });
        });

        // O prompt vai inteiramente pelo stdin — nunca como argumento — para
        // que aspas, barras, %, ^, &, !, acentos e quebras de linha nunca
        // passem por nenhum shell.
        child.stdin.write(prompt, "utf8");
        child.stdin.end();
      });
    }
  );
}

/**
 * Interpreta uma linha do stream `stream-json`, escrevendo o texto no canal e
 * acumulando-o em `state.text` (a extração de blocos de código só corre depois
 * do `close`, sobre o texto completo).
 */
function handleStreamLine(line: string, state: StreamState): void {
  let parsed: StreamJsonLine;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A CLI pode emitir ocasionalmente linhas de debug não-JSON.
    // Escrevemos tal como vêm (sem as acumular na resposta), em vez de rebentar o parser.
    outputChannel.append(line + "\n");
    return;
  }

  if (
    parsed.type === "stream_event" &&
    parsed.event?.type === "content_block_delta" &&
    parsed.event.delta?.type === "text_delta" &&
    typeof parsed.event.delta.text === "string"
  ) {
    outputChannel.append(parsed.event.delta.text);
    state.text += parsed.event.delta.text;
    state.receivedAnyDelta = true;
    return;
  }

  if (parsed.type === "result") {
    // Fallback: se nada foi transmitido em streaming, mostra o resultado final.
    if (!state.receivedAnyDelta && typeof parsed.result === "string") {
      outputChannel.append(parsed.result);
      state.text = parsed.result;
    }

    const usage = parsed.usage;
    const parts: string[] = [];
    if (usage) {
      parts.push(`tokens: ${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out`);
    }
    if (typeof parsed.total_cost_usd === "number") {
      parts.push(`custo: $${parsed.total_cost_usd.toFixed(4)}`);
    }
    if (parts.length > 0) {
      outputChannel.appendLine(`\n\n[${parts.join(" · ")}]`);
    }

    if (parsed.is_error) {
      state.isError = true;
      vscode.window.showWarningMessage("Claude CLI Lite: a CLI reportou um erro. Vê o canal para detalhes.");
    }

    return;
  }

  // Outros tipos de evento (system, message_start, etc.) são ignorados
  // silenciosamente — não são relevantes para o utilizador final.
}

// ---------------------------------------------------------------------------
// Tratamento de erros de arranque do processo
// ---------------------------------------------------------------------------

function reportSpawnFailure(err: NodeJS.ErrnoException | any, cliPath: string): void {
  const notFound =
    err?.code === "ENOENT" ||
    err?.code === 9009 ||
    (typeof err?.message === "string" && /is not recognized|not found/i.test(err.message));

  if (notFound) {
    outputChannel.appendLine(`\n[erro] CLI "${cliPath}" não encontrada.`);
    vscode.window
      .showErrorMessage(
        `Claude CLI Lite: não foi possível encontrar a CLI "${cliPath}". Confirma que o Claude Code está instalado e no PATH, ou define o caminho completo nas definições.`,
        "Abrir definições"
      )
      .then((choice) => {
        if (choice === "Abrir definições") {
          vscode.commands.executeCommand("workbench.action.openSettings", "claudeCliLite.cliPath");
        }
      });
    return;
  }

  outputChannel.appendLine(`\n[erro] ${err?.message ?? String(err)}`);
  vscode.window.showErrorMessage(`Claude CLI Lite: erro ao executar a CLI — ${err?.message ?? String(err)}`);
}

// ---------------------------------------------------------------------------
// Cancelamento: matar a árvore de processos
// ---------------------------------------------------------------------------

/**
 * `child.kill()` só mata o processo direto — no Windows, com shell:true,
 * isso é o `cmd.exe`, deixando o `claude`/`node` filho a correr. Por isso,
 * no Windows usamos `taskkill /T` para matar toda a árvore.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    exec(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true }, () => {
      /* ignora erros — o processo pode já ter terminado */
    });
  } else {
    child.kill();
  }
}

/** Formatação simples só para o log do comando executado no OutputChannel. */
function quoteForDisplay(arg: string): string {
  if (arg === "") {
    return '""';
  }
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

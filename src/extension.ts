/**
 * CLIte-ai
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
import * as fs from "fs";
import { ChildProcessWithoutNullStreams } from "child_process";
import { launchCli } from "./launcher";
import { LineSplitter, MAX_INPUT_BYTES, MAX_OUTPUT_CHARS, MAX_STDOUT_LINE_CHARS, terminateTree, Watchdog, TimeoutKind } from "./lifecycle";
import { isPlatformBlocked, PLATFORM_BLOCKED_MESSAGE } from "./platform";
import { buildPrompt, buildFullPrompt } from "./prompt";
import * as conversation from "./conversation";
import * as cart from "./contextCart";
import * as proposal from "./proposal";
import { isValidModel, nonNegativeNumberOr } from "./validation";
import { redact, StreamRedactor } from "./secrets";
import { buildPreview } from "./preview";
import { migrateOnce } from "./migration";
import { cancellableWait, Cancellable } from "./waiting";
import { buildTypedArgs, validateExtraArgs } from "./args";
import { buildChildEnv } from "./env";

// ---------------------------------------------------------------------------
// Estado do módulo
// ---------------------------------------------------------------------------

/** Canal de output onde a resposta da CLI é escrita em streaming. */
let outputChannel: vscode.OutputChannel;

/**
 * Pedido em andamento (só um de cada vez). Existe do início do pedido até o `close`
 * real do processo: cancelar NÃO o apaga, só marca `cancelled` e encerra o processo.
 */
interface ActiveRequest {
  child?: ChildProcessWithoutNullStreams;
  cancelled: boolean;
}
let activeRequest: ActiveRequest | undefined;

/** Verdadeiro desde o início de `ask()` (caixa de pergunta, prévia e confirmações incluídas). */
let askInFlight = false;

/** Barra de estado: nº de turnos na memória e de ficheiros no carrinho. */
let statusBar: vscode.StatusBarItem;

/** Contexto da extensão, para guardar "a prévia já foi mostrada" no globalState. */
let extContext: vscode.ExtensionContext;

// Prévia do envio: documento virtual somente leitura (S7).
const PREVIEW_SCHEME = "clite-ai-preview";
const previewContents = new Map<string, string>();
let previewCounter = 0;

class PreviewProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return previewContents.get(uri.path) ?? "";
  }
}

/** Tempo máximo que a prévia espera uma resposta antes de contar como cancelada. */
const PREVIEW_TIMEOUT_MS = 2 * 60 * 1000;

/** Espera pela confirmação da prévia, quando houver uma, para o comando Cancelar poder encerrá-la. */
let pendingPreview: Cancellable<string | undefined> | undefined;

/**
 * Abre a prévia ao lado e pergunta se pode enviar. Fechar o aviso, esperar mais de
 * 2 minutos ou rodar "Cancelar pedido" contam como cancelar. O aviso não é modal de
 * propósito (o usuário precisa ler a prévia ao lado), por isso ele pode ficar sem
 * resposta, e a extensão não pode ficar "ocupada" para sempre por causa disso.
 */
async function confirmPreview(text: string): Promise<boolean> {
  const id = `/previa-${++previewCounter}.txt`;
  previewContents.set(id, text);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: id }));
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    pendingPreview = cancellableWait(
      Promise.resolve(
        vscode.window.showInformationMessage(
          "CLIte-ai: revise o que vai ser enviado (aberto ao lado). Enviar?",
          "Enviar",
          "Cancelar"
        )
      ),
      PREVIEW_TIMEOUT_MS
    );
    const choice = await pendingPreview.promise;
    return choice === "Enviar";
  } finally {
    pendingPreview?.cancel(); // limpa o timer
    pendingPreview = undefined;
    previewContents.delete(id);
  }
}

/** Tudo o que vai para o canal de saída passa por `redact`, para nenhum segredo aparecer em claro (S11). */
function logAppend(text: string): void {
  outputChannel.append(redact(text));
}
function logLine(text: string): void {
  outputChannel.appendLine(redact(text));
}
/** Para texto que já passou pelo StreamRedactor. */
function logRaw(text: string): void {
  if (text) {
    outputChannel.append(text);
  }
}

// ---------------------------------------------------------------------------
// Ativação / desativação
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  // Copia as configurações do prefixo antigo (ver migration.ts), uma vez. Não bloqueia a ativação.
  void migrateOnce(context);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, new PreviewProvider()));
  outputChannel = vscode.window.createOutputChannel("CLIte-ai");
  context.subscriptions.push(outputChannel);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "cliteAi.statusMenu";
  context.subscriptions.push(statusBar);

  // Os módulos avisam-nos quando o estado muda, para refrescarmos a barra.
  conversation.setOnChange(updateStatusBar);
  cart.setOnChange(updateStatusBar);
  proposal.setOnChange(updateStatusBar);
  proposal.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("cliteAi.askSelection", () => ask("new")),
    vscode.commands.registerCommand("cliteAi.continueConversation", () => ask("continue")),
    vscode.commands.registerCommand("cliteAi.clearConversation", clearConversation),
    vscode.commands.registerCommand("cliteAi.addToContext", cart.addToContext),
    vscode.commands.registerCommand("cliteAi.manageContext", cart.manageContext),
    vscode.commands.registerCommand("cliteAi.clearContext", cart.clearContext),
    vscode.commands.registerCommand("cliteAi.showProposal", proposal.showProposal),
    vscode.commands.registerCommand("cliteAi.applyProposal", proposal.applyProposal),
    vscode.commands.registerCommand("cliteAi.discardProposal", proposal.discardProposal),
    vscode.commands.registerCommand("cliteAi.statusMenu", statusMenu),
    vscode.commands.registerCommand("cliteAi.cancel", cancelCurrent)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cliteAi.extraArgs")) {
        updateStatusBar();
      }
    })
  );

  updateStatusBar();
}

export function deactivate(): void {
  // Não deixar processos órfãos quando a extensão é desativada / o editor fecha.
  if (activeRequest?.child) {
    activeRequest.cancelled = true;
    terminateTree(activeRequest.child);
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
  // Ocupado desde o começo até o fim de verdade, não só quando o processo existe.
  if (askInFlight || activeRequest) {
    vscode.window.showWarningMessage(
      pendingPreview
        ? "CLIte-ai: há uma prévia aguardando a sua resposta (aberta ao lado). Responda Enviar ou Cancelar, ou rode CLIte-ai: Cancelar pedido."
        : "CLIte-ai: já há um pedido em curso. Cancela-o (CLIte-ai: Cancelar pedido) antes de iniciar outro."
    );
    return;
  }
  askInFlight = true;
  try {
    await runAsk(mode);
  } finally {
    askInFlight = false;
  }
}

async function runAsk(mode: "new" | "continue"): Promise<void> {
  const rejected = rejectedExtraArgs();
  if (rejected.length > 0) {
    const list = rejected.slice(0, 3).map((r) => `${r.arg} (${r.reason})`).join("; ");
    vscode.window.showErrorMessage(
      `CLIte-ai: cliteAi.extraArgs tem argumentos que não são permitidos: ${list}. Corrija as configurações antes de continuar.`
    );
    return;
  }

  // Windows bloqueado no preview até a verificação em máquina real (S19).
  if (isPlatformBlocked(process.platform)) {
    vscode.window.showErrorMessage(PLATFORM_BLOCKED_MESSAGE);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const selection = editor?.selection;
  const selectedText = editor && selection ? editor.document.getText(selection) : "";
  const hasSelection = selectedText.trim().length > 0;

  if (mode === "new") {
    if (!editor) {
      vscode.window.showWarningMessage("CLIte-ai: nenhum editor ativo.");
      return;
    }
    if (!hasSelection) {
      vscode.window.showWarningMessage("CLIte-ai: seleciona algum código primeiro.");
      return;
    }
  } else if (!hasSelection && conversation.getTurns().length === 0) {
    vscode.window.showWarningMessage("CLIte-ai: não há conversa; usa \"Nova pergunta sobre seleção\".");
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
  if (!(await cart.confirmFindings(cartNow.files, selectedText))) {
    return;
  }

  const prompt = buildFullPrompt({ files: cartNow.files, turns, request, hasTarget: target !== undefined });

  // Por padrão a CLI roda numa pasta vazia e temporária, e não no projeto. Assim ela não
  // lê CLAUDE.md nem hooks do projeto e não manda o git status (branch, autor, commits).
  let run: RunDir;
  try {
    run = prepareRunDir(cwdUri);
  } catch (err: any) {
    vscode.window.showErrorMessage(`CLIte-ai: não foi possível criar a pasta temporária (${redact(err?.message ?? String(err))}).`);
    return;
  }

  // Tudo daqui até o fim do pedido fica dentro do try: a pasta temporária é apagada em qualquer
  // saída, inclusive se a prévia falhar ao abrir.
  let result: RunResult;
  try {
    if (Buffer.byteLength(prompt, "utf8") > MAX_INPUT_BYTES) {
      vscode.window.showErrorMessage(
        `CLIte-ai: o texto a enviar passa de ${Math.round(MAX_INPUT_BYTES / (1024 * 1024))} MB, que é o limite. Tire arquivos do contexto ou reduza a seleção.`
      );
      return;
    }

    // Prévia do que vai ser enviado: no primeiro uso, e sempre que `alwaysPreview` estiver ligado.
    const alwaysPreview = vscode.workspace.getConfiguration("cliteAi").get<boolean>("alwaysPreview", false);
    if (alwaysPreview || !extContext.globalState.get<boolean>("previewShown.claude", false)) {
      const previewText = buildPreview({
        engine: "Claude Code CLI",
        model: vscode.workspace.getConfiguration("cliteAi").get<string>("model", "").trim(),
        cwdMode: run.mode,
        workspaceTrusted: vscode.workspace.isTrusted,
        args: buildArgs(true),
        prompt,
        files: cartNow.files.map((f) => ({ path: f.path, chars: f.content.length })),
        historyTurns: turns.length,
        historyChars,
        selectionChars: selectedText.length,
        notes: [...cartNow.notes, ...run.notes],
        envNames: buildChildEnv(process.env, vscode.workspace.getConfiguration("cliteAi").get<string[]>("extraEnvNames", [])).names,
      });
      const approved = await confirmPreview(previewText);
      if (!approved) {
        return;
      }
      await extContext.globalState.update("previewShown.claude", true);
    }

    result = await runClaude(prompt, run.cwd, [...cartNow.notes, ...run.notes, summaryLine]);
  } finally {
    run.cleanup();
  }
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
  vscode.window.showInformationMessage("CLIte-ai: conversa limpa.");
}

function cancelCurrent(): void {
  // Prévia aguardando confirmação: cancelar encerra a espera e o pedido nem começa.
  if (pendingPreview) {
    pendingPreview.cancel();
    return;
  }
  if (!activeRequest) {
    vscode.window.showInformationMessage("CLIte-ai: não há nenhum pedido em curso.");
    return;
  }
  activeRequest.cancelled = true;
  // A mensagem "[cancelado pelo utilizador]" é escrita no `close` do processo (runClaude),
  // para aparecer também quando se cancela pelo botão da notificação. O pedido só deixa
  // de estar "em curso" quando o processo realmente terminar.
  if (activeRequest.child) {
    terminateTree(activeRequest.child);
  }
}

// ---------------------------------------------------------------------------
// Barra de estado e menu de estado
// ---------------------------------------------------------------------------

function updateStatusBar(): void {
  const turns = conversation.getTurns().length;
  const files = cart.count();
  // Aviso permanente enquanto houver argumentos extras configurados (modo avançado).
  const extra = vscode.workspace.getConfiguration("cliteAi").get<unknown>("extraArgs", []);
  const advanced = Array.isArray(extra) && extra.length > 0;
  if (turns === 0 && files === 0 && !advanced) {
    statusBar.hide();
    return;
  }
  statusBar.text = `${advanced ? "$(warning) " : ""}$(comment-discussion) ${turns}  $(file) ${files}`;
  statusBar.tooltip =
    `CLIte-ai: ${turns} turno(s) na conversa · ${files} ficheiro(s) no contexto` +
    (advanced ? " · MODO AVANÇADO: há argumentos extras da CLI configurados (cliteAi.extraArgs)" : "");
  statusBar.show();
}

async function statusMenu(): Promise<void> {
  const items: (vscode.QuickPickItem & { command: string })[] = [
    { label: "Continuar conversa", command: "cliteAi.continueConversation" },
    { label: "Limpar conversa", command: "cliteAi.clearConversation" },
    { label: "Gerir contexto", command: "cliteAi.manageContext" },
    { label: "Limpar contexto", command: "cliteAi.clearContext" },
  ];
  if (proposal.hasProposal()) {
    items.push({ label: "Ver alterações propostas", command: "cliteAi.showProposal" });
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "CLIte-ai" });
  if (picked) {
    await vscode.commands.executeCommand(picked.command);
  }
}

// ---------------------------------------------------------------------------
// Construção dos argumentos da CLI (modo "cirúrgico")
// ---------------------------------------------------------------------------

function buildArgs(quiet = false): string[] {
  const config = vscode.workspace.getConfiguration("cliteAi");
  const model = config.get<string>("model", "").trim();

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
    // Só as configurações do usuário. As do projeto (.claude/settings.json) podem ter hooks
    // que rodariam código a cada pedido, e `-p` não mostra o diálogo de confiança.
    "--setting-sources",
    "user",
  ];

  if (model) {
    if (isValidModel(model)) {
      args.push("--model", model);
    } else if (!quiet) {
      // Nunca repassamos um valor estranho à CLI.
      vscode.window.showWarningMessage(
        "CLIte-ai: o nome do modelo tem caracteres não permitidos e foi ignorado. Corrija em cliteAi.model."
      );
    }
  }

  // Opções tipadas (effort, fallbackModel, maxBudgetUsd): só entram valores válidos.
  const typed = buildTypedArgs({
    effort: config.get<string>("effort", ""),
    fallbackModel: config.get<string>("fallbackModel", ""),
    maxBudgetUsd: config.get<number>("maxBudgetUsd", 0),
  });
  if (!quiet && typed.warnings.length > 0) {
    vscode.window.showWarningMessage(`CLIte-ai: ${typed.warnings.join("; ")}.`);
  }
  args.push(...typed.args);

  // Em workspace não confiável nenhum argumento extra passa, nem os do usuário: modo estrito.
  // As flags proibidas já foram barradas em `rejectedExtraArgs` antes do pedido.
  const extra = vscode.workspace.isTrusted ? validateExtraArgs(config.get<unknown>("extraArgs", [])).args : [];
  return [...args, ...extra];
}

/** Flags proibidas em `extraArgs`, para avisar antes de pedir qualquer coisa ao usuário. */
function rejectedExtraArgs(): Array<{ arg: string; reason: string }> {
  if (!vscode.workspace.isTrusted) {
    return []; // em workspace não confiável os extras são ignorados de qualquer jeito
  }
  return validateExtraArgs(vscode.workspace.getConfiguration("cliteAi").get<unknown>("extraArgs", [])).rejected;
}

/** Pasta onde a CLI roda neste pedido, com o aviso para o canal e a limpeza. */
interface RunDir {
  cwd: string;
  mode: "neutra" | "projeto";
  notes: string[];
  cleanup: () => void;
}

/**
 * Pasta de trabalho do processo. O padrão é uma pasta temporária vazia, criada para
 * este pedido e apagada no fim. A pasta do projeto só é usada se o usuário ligou
 * `includeGitContext` (configuração de máquina) E o workspace é confiável.
 */
function prepareRunDir(uri: vscode.Uri | undefined): RunDir {
  const includeGit = vscode.workspace.getConfiguration("cliteAi").get<boolean>("includeGitContext", false);
  if (includeGit && vscode.workspace.isTrusted && uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return {
        cwd: folder.uri.fsPath,
        mode: "projeto",
        notes: ["[aviso] includeGitContext ligado: a CLI roda na pasta do projeto e envia branch, autor e commits recentes do git."],
        cleanup: () => {},
      };
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clite-ai-"));
  return {
    cwd: dir,
    mode: "neutra",
    notes: vscode.workspace.isTrusted ? [] : ["[workspace não confiável] modo estrito: extraArgs ignorados e CLI numa pasta temporária vazia."],
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a pasta é temporária, se não der para apagar o sistema limpa depois */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Execução da CLI com streaming
// ---------------------------------------------------------------------------

/** Formato (parcial) dos eventos que a CLI emite com --output-format stream-json. */
interface StreamJsonLine {
  type?: string;
  subtype?: string;
  /** Evento `system/init`: ferramentas e servidores MCP carregados pela CLI. */
  tools?: unknown;
  mcp_servers?: unknown;
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
  /** Preenchido quando o evento `init` mostra ferramentas ou MCP carregados (o pedido é abortado). */
  initViolation?: string;
  /** Redige a resposta em streaming sem deixar um segredo escapar entre dois pedaços. */
  redactor: StreamRedactor;
}

/** `headerLines` são escritas no canal antes do comando (resumo do contexto, avisos do carrinho). */
async function runClaude(prompt: string, cwd: string, headerLines: string[] = []): Promise<RunResult> {
  const config = vscode.workspace.getConfiguration("cliteAi");
  const cliPath = config.get<string>("cliPath", "claude").trim() || "claude";
  const args = buildArgs();
  const childEnv = buildChildEnv(process.env, config.get<string[]>("extraEnvNames", []));
  const idleMs = nonNegativeNumberOr(config.get<unknown>("timeoutIdleSeconds", 180), 180) * 1000;
  const totalMs = nonNegativeNumberOr(config.get<unknown>("timeoutTotalSeconds", 1200), 1200) * 1000;

  // Este pedido tem estado próprio. Nada aqui é global, e `activeRequest` só é apagado no `close`.
  const request: ActiveRequest = { cancelled: false };
  activeRequest = request;

  outputChannel.clear();
  outputChannel.show(true);
  for (const line of headerLines) {
    logLine(line);
  }
  logLine(`$ ${cliPath} ${args.map(quoteForDisplay).join(" ")}`);
  logLine("");

  return vscode.window.withProgress<RunResult>(
    {
      location: vscode.ProgressLocation.Notification,
      title: "CLIte-ai",
      cancellable: true,
    },
    (progress, cancellationToken) => {
      progress.report({ message: "a perguntar ao Claude…" });

      return new Promise<RunResult>((resolve) => {
        const finish = (result: RunResult): void => {
          if (activeRequest === request) {
            activeRequest = undefined;
          }
          resolve(result);
        };

        // Nunca usamos shell. O executável é resolvido e validado em `launcher.ts`
        // (no Windows, o shim .cmd do npm vai pelo cmd.exe com argumentos permitidos).
        let child: ChildProcessWithoutNullStreams;
        try {
          child = launchCli(cliPath, args, { cwd, env: { ...childEnv.env, NO_COLOR: "1" } });
        } catch (err: any) {
          reportSpawnFailure(err, cliPath);
          finish({ ok: false, text: "" });
          return;
        }
        request.child = child;

        cancellationToken.onCancellationRequested(() => {
          request.cancelled = true;
          terminateTree(child);
        });

        const splitter = new LineSplitter(MAX_STDOUT_LINE_CHARS);
        const state: StreamState = { receivedAnyDelta: false, text: "", isError: false, redactor: new StreamRedactor() };
        let spawnFailed = false;
        let timeoutKind: TimeoutKind | undefined;
        let outputExceeded = false;
        let lineOverflow = false;
        let terminating = false;
        const stopForReason = (): void => {
          if (!terminating) {
            terminating = true;
            terminateTree(child);
          }
        };

        // Sem sinal de vida por muito tempo, ou tempo total demais: encerra.
        const watchdog = new Watchdog(idleMs, totalMs, (kind) => {
          timeoutKind = kind;
          stopForReason();
        });

        child.stdout.setEncoding("utf8"); // evita cortar caracteres multi-byte entre chunks
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk: string) => {
          watchdog.touch();
          const { lines, overflow } = splitter.push(chunk);
          lineOverflow = lineOverflow || overflow;
          // Depois de cancelar (ou de decidir encerrar) a saída é descartada.
          if (request.cancelled || terminating) {
            return;
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            handleStreamLine(line, state);
            if (state.initViolation || state.text.length > MAX_OUTPUT_CHARS) {
              outputExceeded = outputExceeded || state.text.length > MAX_OUTPUT_CHARS;
              stopForReason();
              break;
            }
          }
        });

        child.stderr.on("data", (chunk: string) => {
          watchdog.touch();
          if (!request.cancelled && !terminating) {
            logAppend(`[stderr] ${chunk}`);
          }
        });

        // Se a CLI sair antes de ler tudo, o `write` dá EPIPE. O `close` já trata o resultado.
        child.stdin.on("error", () => {
          /* ignorado de propósito */
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
          spawnFailed = true;
          reportSpawnFailure(err, cliPath);
        });

        child.on("close", (code) => {
          watchdog.stop();
          if (spawnFailed) {
            finish({ ok: false, text: "" });
            return;
          }

          // Processa qualquer resto sem newline final.
          const rest = splitter.flush();
          if (rest.trim().length > 0 && !request.cancelled && !terminating) {
            handleStreamLine(rest, state);
          }
          logRaw(state.redactor.flush());

          if (state.initViolation) {
            logLine(`\n[pedido abortado por segurança] ${state.initViolation}.`);
            vscode.window.showErrorMessage(
              `CLIte-ai: pedido abortado por segurança (${state.initViolation}). Veja o canal "CLIte-ai".`
            );
            finish({ ok: false, text: "" });
            return;
          }

          // Cancelado pelo comando ou pelo botão da notificação: não é um erro.
          if (request.cancelled || cancellationToken.isCancellationRequested) {
            logLine("\n\n[cancelado pelo utilizador]");
            finish({ ok: false, text: state.text });
            return;
          }

          if (timeoutKind) {
            const motivo = timeoutKind === "idle" ? "sem nenhuma resposta por tempo demais" : "passou do tempo total permitido";
            logLine(`\n\n[pedido encerrado: ${motivo}]`);
            vscode.window.showErrorMessage(`CLIte-ai: pedido encerrado (${motivo}). Os limites estão em timeoutIdleSeconds e timeoutTotalSeconds.`);
            finish({ ok: false, text: "" });
            return;
          }

          if (outputExceeded) {
            logLine("\n\n[resposta cortada: passou do limite de tamanho]");
            vscode.window.showErrorMessage("CLIte-ai: a resposta passou do limite de tamanho e foi descartada.");
            finish({ ok: false, text: "" });
            return;
          }

          if (lineOverflow) {
            logLine("\n[aviso] uma linha de saída da CLI era grande demais e foi descartada.");
          }

          if (code !== 0) {
            logLine(`\n[processo terminou com código ${code}]`);
            vscode.window.showErrorMessage(
              `CLIte-ai: a CLI terminou com código ${code}. Vê o canal "CLIte-ai" para detalhes.`
            );
          }

          finish({ ok: code === 0 && !state.isError, text: state.text });
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
    logAppend(line + "\n");
    return;
  }

  // Falha fechada: a extensão promete uma CLI sem ferramentas e sem MCP. Se o evento `init`
  // mostrar o contrário (ou não der para conferir), o pedido é abortado. Isto é uma trava
  // de segurança, não a defesa principal (a defesa são as flags e a pasta neutra).
  if (parsed.type === "system" && parsed.subtype === "init") {
    if (!Array.isArray(parsed.tools) || !Array.isArray(parsed.mcp_servers)) {
      state.initViolation = "não foi possível conferir as ferramentas e servidores MCP que a CLI carregou";
    } else if (parsed.tools.length > 0 || parsed.mcp_servers.length > 0) {
      state.initViolation = `a CLI carregou ${parsed.tools.length} ferramenta(s) e ${parsed.mcp_servers.length} servidor(es) MCP, e o esperado é nenhum`;
    }
    return;
  }

  if (
    parsed.type === "stream_event" &&
    parsed.event?.type === "content_block_delta" &&
    parsed.event.delta?.type === "text_delta" &&
    typeof parsed.event.delta.text === "string"
  ) {
    logRaw(state.redactor.push(parsed.event.delta.text));
    state.text += parsed.event.delta.text;
    state.receivedAnyDelta = true;
    return;
  }

  if (parsed.type === "result") {
    // Fallback: se nada foi transmitido em streaming, mostra o resultado final.
    if (!state.receivedAnyDelta && typeof parsed.result === "string") {
      logAppend(parsed.result);
      state.text = parsed.result;
    }

    // O que ainda estava retido pelo redator sai antes da linha de uso.
    logRaw(state.redactor.flush());

    const usage = parsed.usage;
    const parts: string[] = [];
    if (usage) {
      parts.push(`tokens: ${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out`);
    }
    if (typeof parsed.total_cost_usd === "number") {
      parts.push(`custo: $${parsed.total_cost_usd.toFixed(4)}`);
    }
    if (parts.length > 0) {
      logLine(`\n\n[${parts.join(" · ")}]`);
    }

    if (parsed.is_error) {
      state.isError = true;
      vscode.window.showWarningMessage("CLIte-ai: a CLI reportou um erro. Vê o canal para detalhes.");
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
    logLine(`\n[erro] CLI "${cliPath}" não encontrada.`);
    vscode.window
      .showErrorMessage(
        `CLIte-ai: não foi possível encontrar a CLI "${cliPath}". Confirma que o Claude Code está instalado e no PATH, ou define o caminho completo nas definições.`,
        "Abrir definições"
      )
      .then((choice) => {
        if (choice === "Abrir definições") {
          vscode.commands.executeCommand("workbench.action.openSettings", "cliteAi.cliPath");
        }
      });
    return;
  }

  logLine(`\n[erro] ${err?.message ?? String(err)}`);
  vscode.window.showErrorMessage(`CLIte-ai: erro ao executar a CLI — ${redact(err?.message ?? String(err))}`);
}

/** Formatação simples só para o log do comando executado no OutputChannel. */
function quoteForDisplay(arg: string): string {
  if (arg === "") {
    return '""';
  }
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Ciclo de vida do processo da CLI (S8) e limites (S9). Sem dependência do `vscode`.
 */

import { ChildProcess, execFile } from "child_process";
import * as path from "path";

// ---------------------------------------------------------------------------
// Encerrar o processo e os filhos dele
// ---------------------------------------------------------------------------

export interface TerminateOptions {
  platform?: NodeJS.Platform;
  /** Quanto esperar depois do SIGINT antes de mandar SIGTERM. */
  sigintMs?: number;
  /** Quanto esperar (desde o início) antes de mandar SIGKILL. */
  sigkillMs?: number;
}

function killWindowsTree(pid: number): void {
  // Sem shell: taskkill por caminho absoluto e argumentos em lista.
  const root = process.env.SystemRoot || "C:\\Windows";
  execFile(path.win32.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {
    /* ignora erros: o processo pode já ter terminado */
  });
}

/**
 * Encerra o processo e tudo o que ele iniciou. Fora do Windows o processo precisa
 * ter sido criado com `detached: true` (vira líder de um grupo), e o sinal vai
 * para o grupo inteiro: primeiro SIGINT (encerra o turno com educação), depois
 * SIGTERM e por fim SIGKILL, com prazos. No Windows usa `taskkill /T /F`.
 */
export function terminateTree(child: ChildProcess, options: TerminateOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (platform === "win32") {
    killWindowsTree(pid);
    return;
  }

  const send = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* já terminou */
      }
    }
  };

  send("SIGINT");
  const toTerm = setTimeout(() => send("SIGTERM"), options.sigintMs ?? 2000);
  const toKill = setTimeout(() => send("SIGKILL"), options.sigkillMs ?? 5000);
  child.once("exit", () => {
    clearTimeout(toTerm);
    clearTimeout(toKill);
    // O líder saiu, mas algum filho pode ter ficado para trás no grupo.
    send("SIGKILL");
  });
}

// ---------------------------------------------------------------------------
// Tempo limite
// ---------------------------------------------------------------------------

export type TimeoutKind = "idle" | "total";

/** Dispara se ficar `idleMs` sem sinal de vida (touch) ou se passar `totalMs` no total. 0 desliga. */
export class Watchdog {
  private idleTimer?: NodeJS.Timeout;
  private totalTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly idleMs: number,
    totalMs: number,
    private readonly onTimeout: (kind: TimeoutKind) => void
  ) {
    if (totalMs > 0) {
      this.totalTimer = setTimeout(() => this.fire("total"), totalMs);
    }
    this.touch();
  }

  touch(): void {
    if (this.stopped || this.idleMs <= 0) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fire("idle"), this.idleMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.totalTimer);
  }

  private fire(kind: TimeoutKind): void {
    if (this.stopped) {
      return;
    }
    this.stop();
    this.onTimeout(kind);
  }
}

// ---------------------------------------------------------------------------
// Linhas do stdout com tamanho máximo
// ---------------------------------------------------------------------------

/**
 * Separa o stdout em linhas. Uma linha que passa de `maxLineChars` é descartada
 * (com aviso em `overflow`), sem deixar o buffer crescer sem limite.
 */
export class LineSplitter {
  private buf = "";
  private skipping = false;

  constructor(private readonly maxLineChars: number) {}

  push(chunk: string): { lines: string[]; overflow: boolean } {
    const lines: string[] = [];
    let overflow = false;
    let data = chunk;
    while (data.length > 0) {
      const nl = data.indexOf("\n");
      if (nl === -1) {
        if (!this.skipping) {
          this.buf += data;
          if (this.buf.length > this.maxLineChars) {
            this.buf = "";
            this.skipping = true;
            overflow = true;
          }
        }
        break;
      }
      const piece = data.slice(0, nl);
      data = data.slice(nl + 1);
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      const line = this.buf + piece;
      this.buf = "";
      if (line.length > this.maxLineChars) {
        overflow = true;
        continue;
      }
      lines.push(line);
    }
    return { lines, overflow };
  }

  /** O resto sem quebra de linha no fim do stream. */
  flush(): string {
    const rest = this.skipping ? "" : this.buf;
    this.buf = "";
    this.skipping = false;
    return rest;
  }
}

/** Limites fixos. */
export const MAX_INPUT_BYTES = 9 * 1024 * 1024; // folga para o limite de 10 MB do stdin da CLI
export const MAX_STDOUT_LINE_CHARS = 5 * 1024 * 1024;
export const MAX_OUTPUT_CHARS = 2 * 1000 * 1000;

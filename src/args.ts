/**
 * Argumentos extras da CLI (S6). Sem dependência do `vscode`.
 *
 * `extraArgs` continua existindo como opção avançada (escopo de máquina), mas
 * as flags que mexeriam em segurança, em autenticação ou no formato da saída são
 * sempre recusadas, e um argumento solto (que a CLI trataria como parte do
 * prompt) também.
 */

import { isValidModel } from "./validation";

/** Flag proibida e o motivo (a mensagem é mostrada ao usuário). */
const FORBIDDEN: Record<string, string> = {
  "--tools": "religaria ferramentas da CLI",
  "--allowedtools": "liberaria ferramentas da CLI",
  "--allowed-tools": "liberaria ferramentas da CLI",
  "--disallowedtools": "já é fixada pela extensão",
  "--disallowed-tools": "já é fixada pela extensão",
  "--dangerously-skip-permissions": "pularia as permissões",
  "--allow-dangerously-skip-permissions": "pularia as permissões",
  "--permission-mode": "mudaria as permissões",
  "--mcp-config": "carregaria servidores MCP",
  "--strict-mcp-config": "já é fixada pela extensão",
  "--plugin-dir": "carregaria plugins",
  "--plugin-url": "carregaria plugins",
  "--add-dir": "daria acesso a outras pastas",
  "--settings": "carregaria configurações extras",
  "--setting-sources": "já é fixada pela extensão (só configurações do usuário)",
  "--agents": "definiria agentes",
  "--chrome": "ligaria o Claude in Chrome",
  "--bare": "pula o login por assinatura (OAuth)",
  "--safe-mode": "ainda está em avaliação (pode afetar o login)",
  "--print": "já é fixada pela extensão",
  "-p": "já é fixada pela extensão",
  "--output-format": "quebraria a leitura da resposta",
  "--input-format": "quebraria o envio do prompt",
  "--include-partial-messages": "já é fixada pela extensão",
  "--verbose": "já é fixada pela extensão",
  "--no-session-persistence": "já é fixada pela extensão",
  "--resume": "retomaria uma sessão gravada",
  "-r": "retomaria uma sessão gravada",
  "--continue": "retomaria uma sessão gravada",
  "-c": "retomaria uma sessão gravada",
  "--session-id": "gravaria uma sessão",
  "--model": "use a configuração cliteAi.model",
  "--fallback-model": "use a configuração cliteAi.fallbackModel",
  "--effort": "use a configuração cliteAi.effort",
  "--max-budget-usd": "use a configuração cliteAi.maxBudgetUsd",
  "--": "tudo depois dele viraria parte do prompt",
};

export interface ExtraArgsResult {
  args: string[];
  rejected: Array<{ arg: string; reason: string }>;
}

/**
 * Lista de recusa, não de permissão: uma flag que a CLI ganhar no futuro e não estiver
 * na tabela acima passa. Por isso `extraArgs` fica em escopo de máquina, ignorado em
 * workspace não confiável e sinalizado na barra de status como modo avançado.
 */
export function validateExtraArgs(extra: unknown): ExtraArgsResult {
  const result: ExtraArgsResult = { args: [], rejected: [] };
  if (extra === undefined || extra === null) {
    return result;
  }
  if (!Array.isArray(extra) || extra.some((a) => typeof a !== "string")) {
    result.rejected.push({ arg: "(extraArgs)", reason: "precisa ser uma lista de textos" });
    return result;
  }

  // O que a flag anterior fez: aceita ou recusa o valor que vier logo depois.
  let previous: "none" | "accepted" | "rejected" = "none";
  for (const token of extra as string[]) {
    if (token.startsWith("-") && token !== "-") {
      const name = token.split("=")[0].toLowerCase();
      let reason = FORBIDDEN[name];
      // Letras juntas: "-pc" é "-p" e "-c" ao mesmo tempo. Cada letra do grupo é conferida.
      if (!reason && /^-[^-]/.test(token)) {
        for (const letter of token.slice(1).split("=")[0]) {
          const found = FORBIDDEN[`-${letter.toLowerCase()}`];
          if (found) {
            reason = `${found} (a letra "${letter}" no grupo "${token}")`;
            break;
          }
        }
      }
      const hasInlineValue = token.includes("=");
      if (reason) {
        result.rejected.push({ arg: token, reason });
        previous = hasInlineValue ? "none" : "rejected";
      } else {
        result.args.push(token);
        previous = hasInlineValue ? "none" : "accepted";
      }
      continue;
    }
    // Não começa com "-": só é valor se logo antes veio uma flag sem "=".
    if (previous === "accepted") {
      result.args.push(token);
    } else if (previous === "rejected") {
      result.rejected.push({ arg: token, reason: "valor de uma flag recusada" });
    } else {
      result.rejected.push({ arg: token, reason: "argumento solto: a CLI o trataria como parte do prompt" });
    }
    previous = "none";
  }
  return result;
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface TypedOptions {
  effort?: string;
  fallbackModel?: string;
  maxBudgetUsd?: number;
}

/** Converte as configurações tipadas em flags. O que for inválido é ignorado (e vira aviso). */
export function buildTypedArgs(opts: TypedOptions): { args: string[]; warnings: string[] } {
  const args: string[] = [];
  const warnings: string[] = [];

  const effort = (opts.effort ?? "").trim();
  if (effort) {
    if ((EFFORT_LEVELS as readonly string[]).includes(effort)) {
      args.push("--effort", effort);
    } else {
      warnings.push(`effort "${effort.slice(0, 20)}" inválido; use ${EFFORT_LEVELS.join(", ")}`);
    }
  }

  const fallback = (opts.fallbackModel ?? "").trim();
  if (fallback) {
    if (isValidModel(fallback)) {
      args.push("--fallback-model", fallback);
    } else {
      warnings.push("fallbackModel tem caracteres não permitidos e foi ignorado");
    }
  }

  const budget = opts.maxBudgetUsd;
  if (budget !== undefined && budget !== null && budget !== 0) {
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0 && budget <= 10000) {
      args.push("--max-budget-usd", String(budget));
    } else {
      warnings.push("maxBudgetUsd precisa ser um número maior que 0 (até 10000) e foi ignorado");
    }
  }

  return { args, warnings };
}

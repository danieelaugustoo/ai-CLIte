/**
 * Chaves de configuração da extensão (sem o prefixo). Sem dependência do `vscode`.
 * Um teste confere que esta lista é igual às propriedades declaradas no package.json.
 */

/** Prefixo atual das configurações e dos comandos. */
export const SETTINGS_SECTION = "cliteAi";

/** Prefixo antigo, de quando a extensão se chamava "Claude CLI Lite". Só a migração usa. */
export const OLD_SETTINGS_SECTION = "claudeCliLite";

export const SETTING_KEYS = [
  "cliPath",
  "model",
  "effort",
  "fallbackModel",
  "maxBudgetUsd",
  "extraArgs",
  "extraEnvNames",
  "includeGitContext",
  "alwaysPreview",
  "timeoutIdleSeconds",
  "timeoutTotalSeconds",
  "historyMaxTurns",
  "historyMaxChars",
  "contextMaxChars",
] as const;

/**
 * Validações puras, sem dependência do `vscode`, para poderem ser testadas
 * direto com `node --test`.
 */

/**
 * Lê um número de configuração. Qualquer coisa que não seja um número finito e
 * maior ou igual a zero (um texto no settings.json, por exemplo) vira o padrão.
 * Sem isso, `Math.max(0, "abc")` dá NaN e `setTimeout(NaN)` dispara em 1 ms.
 */
export function nonNegativeNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Nome de modelo aceito: letras, dígitos e . _ : / [ ] -, de 1 a 100 caracteres. */
const MODEL_PATTERN = /^[A-Za-z0-9._:/[\]-]{1,100}$/;

/**
 * O `model` vai como argumento da CLI. Em shells que concatenam argumentos
 * (como o cmd.exe no Windows) um valor como `sonnet & calc` viraria um comando
 * extra, por isso só deixamos passar nomes de modelo "normais".
 */
export function isValidModel(model: string): boolean {
  return MODEL_PATTERN.test(model);
}

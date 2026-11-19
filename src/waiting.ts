/**
 * Espera por uma resposta do usuário que pode ser cancelada ou expirar. Sem
 * dependência do `vscode`.
 *
 * Existe porque um aviso sem botão modal (como o da prévia) pode ficar sem
 * resposta para sempre, e até lá a extensão continuaria "ocupada" sem ter como
 * cancelar (S8).
 */

export interface Cancellable<T> {
  /** Resolve com o valor de `source`, ou com `undefined` se cancelar ou expirar. */
  promise: Promise<T | undefined>;
  /** Cancela a espera (é seguro chamar mais de uma vez, ou depois de resolver). */
  cancel(): void;
}

export function cancellableWait<T>(source: Promise<T>, timeoutMs: number): Cancellable<T> {
  let finish: (value: T | undefined) => void = () => {};
  let timer: NodeJS.Timeout | undefined;

  const promise = new Promise<T | undefined>((resolve) => {
    finish = (value) => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(value);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(undefined), timeoutMs);
    }
    source.then(
      (value) => finish(value),
      () => finish(undefined)
    );
  });

  return { promise, cancel: () => finish(undefined) };
}

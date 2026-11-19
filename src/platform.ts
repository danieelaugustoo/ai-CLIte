/**
 * Bloqueio de plataforma (S19). O Windows continua bloqueado no preview até a
 * extensão ser verificada num Windows de verdade, com a CLI oficial. Esta é uma
 * constante de build, não uma configuração: só muda em código, depois do teste.
 */
export const WINDOWS_VERIFIED = false;

export function isPlatformBlocked(platform: string, windowsVerified: boolean = WINDOWS_VERIFIED): boolean {
  return platform === "win32" && !windowsVerified;
}

export const PLATFORM_BLOCKED_MESSAGE =
  "Claude CLI Lite ainda não foi verificado no Windows e por segurança está bloqueado aqui. Use Linux ou macOS por enquanto.";

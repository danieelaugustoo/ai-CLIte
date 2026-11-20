/**
 * Ambiente do processo da CLI (S16): lista de permitidos. Sem dependência do `vscode`.
 *
 * Antes o processo recebia o ambiente inteiro do VS Code, com qualquer chave ou
 * variável que estivesse lá. Agora só passa o que a CLI precisa para funcionar.
 * `NODE_OPTIONS`, `LD_PRELOAD` e `DYLD_*` ficam de fora de propósito: carregariam
 * código no processo.
 */

const EXACT = [
  "PATH", "PATHEXT", "HOME", "USER", "USERNAME", "LOGNAME", "LANG", "LANGUAGE", "TERM", "COLORTERM",
  "TMPDIR", "TEMP", "TMP", "TZ",
  // Windows
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "PROGRAMFILES",
  // XDG (onde a CLI guarda configuração e login)
  "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  // Rede e certificados
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

/** Prefixos permitidos: configuração de idioma e variáveis da própria CLI. */
const PREFIXES = ["LC_", "ANTHROPIC_", "CLAUDE_"];

function isAllowed(name: string, extraNames: Set<string>): boolean {
  const upper = name.toUpperCase();
  return EXACT.includes(upper) || PREFIXES.some((p) => upper.startsWith(p)) || extraNames.has(upper);
}

export interface ChildEnv {
  env: NodeJS.ProcessEnv;
  /** Só os nomes que foram repassados, nunca os valores (para a prévia). */
  names: string[];
}

/**
 * Monta o ambiente do processo filho. `extraNames` são nomes que o usuário
 * permitiu em `cliteAi.extraEnvNames` (ex.: AWS_PROFILE para quem usa o Bedrock).
 */
export function buildChildEnv(source: NodeJS.ProcessEnv, extraNames: string[] = []): ChildEnv {
  const extra = new Set(extraNames.map((n) => String(n).trim().toUpperCase()).filter((n) => /^[A-Z_][A-Z0-9_]*$/.test(n)));
  const env: NodeJS.ProcessEnv = {};
  const names: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && isAllowed(name, extra)) {
      env[name] = value;
      names.push(name);
    }
  }
  return { env, names: names.sort() };
}

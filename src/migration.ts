/**
 * Migração das configurações do nome antigo (`claudeCliLite.*`) para o novo
 * (`cliteAi.*`). Roda uma vez por instalação.
 *
 * Só os valores do USUÁRIO (settings.json global) são copiados. Valores do
 * workspace ficam para trás de propósito: configurações sensíveis não devem
 * viajar de um repositório para as configurações da pessoa.
 */

import * as vscode from "vscode";
import { OLD_SETTINGS_SECTION, SETTINGS_SECTION, SETTING_KEYS } from "./settingsKeys";

const DONE_FLAG = "settingsMigrated.v1";

/** Copia o que existir no nome antigo e ainda não existir no novo. Devolve as chaves copiadas. */
export async function migrateOldSettings(): Promise<string[]> {
  const root = vscode.workspace.getConfiguration();
  const moved: string[] = [];
  for (const key of SETTING_KEYS) {
    try {
      const oldValue = root.inspect(`${OLD_SETTINGS_SECTION}.${key}`)?.globalValue;
      const newValue = root.inspect(`${SETTINGS_SECTION}.${key}`)?.globalValue;
      if (oldValue !== undefined && newValue === undefined) {
        await root.update(`${SETTINGS_SECTION}.${key}`, oldValue, vscode.ConfigurationTarget.Global);
        moved.push(key);
      }
    } catch {
      /* uma chave que não pôde ser copiada não impede as outras */
    }
  }
  return moved;
}

export async function migrateOnce(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(DONE_FLAG, false)) {
    return;
  }
  const moved = await migrateOldSettings();
  await context.globalState.update(DONE_FLAG, true);
  if (moved.length > 0) {
    vscode.window.showInformationMessage(
      `CLIte-ai: copiei ${moved.length} configuração(ões) de ${OLD_SETTINGS_SECTION}.* para ${SETTINGS_SECTION}.* (${moved.join(", ")}). ` +
        "Você pode apagar as antigas do settings.json. Atalhos de teclado personalizados que usam os comandos antigos precisam ser atualizados."
    );
  }
}

# Claude CLI Lite

Extensão leve para o Opencode (baseado em VS Code) que atua como uma **ponte
visual** entre o editor e a tua instalação global do `claude-code`, já
autenticada no terminal. Não tem inteligência própria, não importa pacotes de
IA e não gere chaves de API — apenas invoca a CLI existente via
`child_process.spawn` e transmite (streaming) a resposta para um
`OutputChannel`.

## Porquê

A integração nativa do Claude no editor envia a árvore de ficheiros completa
e ficheiros inteiros como contexto a cada mensagem, gastando muitos tokens.
Esta extensão só envia a tua instrução + o bloco de código que selecionaste.

## Fluxo de utilização

1. Seleciona um bloco de código no editor.
2. `Ctrl+Shift+C` (ou Command Palette → "Claude: Perguntar sobre seleção").
3. Escreve a instrução na caixa que aparece (ex.: "Refatore isto").
4. A extensão chama `claude -p` com a instrução + código, via stdin.
5. A resposta aparece em streaming no canal de output "Claude CLI Lite".

Para cancelar um pedido em curso: Command Palette → "Claude: Cancelar
pedido", ou clica em "Cancel" na notificação de progresso.

## Instalação e teste local

1. Instalar dependências de desenvolvimento:

   ```bash
   cd claude-cli-lite
   npm install
   ```

2. Compilar:

   ```bash
   npm run compile
   ```

3. Testar em modo de desenvolvimento: abre a pasta `claude-cli-lite` no
   Opencode e pressiona `F5`. Abre uma nova janela ("Extension Development
   Host") com a extensão já ativa. Abre qualquer ficheiro, seleciona código e
   usa `Ctrl+Shift+C`.

4. Empacotar e instalar definitivamente:

   ```bash
   npx @vscode/vsce package
   ```

   Isto gera `claude-cli-lite-0.1.0.vsix`. No Opencode: Command Palette →
   "Extensions: Install from VSIX…" → escolhe o ficheiro gerado.

## Definições

| Definição                    | Default   | Descrição                                                                 |
| ----------------------------- | --------- | -------------------------------------------------------------------------- |
| `claudeCliLite.cliPath`       | `"claude"`| Caminho para o executável da CLI. Usa o caminho completo se não estiver no PATH, ex.: `C:\Users\<user>\AppData\Roaming\npm\claude.cmd`. |
| `claudeCliLite.model`         | `""`      | Modelo a usar (ex.: `sonnet`, `opus`). Vazio = default da CLI.             |
| `claudeCliLite.extraArgs`     | `[]`      | Argumentos extra adicionados no fim da chamada à CLI.                      |

## Se a CLI não for encontrada

A extensão mostra um aviso com um botão "Abrir definições". Define
`claudeCliLite.cliPath` com o caminho completo do executável, por exemplo:

```
C:\Users\<o-teu-utilizador>\AppData\Roaming\npm\claude.cmd
```

## Notas técnicas

- O prompt é sempre enviado via `stdin`, nunca como argumento de linha de
  comando — evita problemas de escape com aspas, barras, `%`, `^`, `&`, `!`
  e quebras de linha no Windows.
- No Windows, o processo é lançado com `shell: true` porque o executável
  instalado pelo npm é um shim `.cmd`.
- A CLI corre em modo "cirúrgico": sem ferramentas (`--tools ""`), sem
  servidores MCP (`--strict-mcp-config`) e sem persistir a sessão em disco
  (`--no-session-persistence`).
- Só é permitido um pedido de cada vez.

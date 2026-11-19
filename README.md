# Claude CLI Lite

Extensão para VS Code que liga o editor à instalação do [Claude Code](https://claude.com/claude-code) que você já tem autenticada no terminal.

Ela não embute SDK de IA e não guarda chave de API. Só chama a CLI com `child_process.spawn`, envia o seu pedido pelo `stdin` e mostra a resposta em streaming.

## Por que existe

As integrações completas mandam a árvore do projeto e arquivos inteiros como contexto a cada mensagem, o que consome muitos tokens. Aqui o contexto é só o que você escolhe: a instrução, o trecho selecionado e os arquivos que você adicionou à mão.

## O que faz

- **Pergunta sobre a seleção.** Selecione um trecho, aperte `Ctrl+Shift+C` e escreva a instrução. A resposta aparece em streaming no canal de saída "Claude CLI Lite".
- **Conversa com memória curta.** `Ctrl+Alt+C` continua a conversa. O histórico fica só na memória da extensão, limitado por número de turnos e de caracteres, e some ao recarregar a janela.
- **Carrinho de contexto.** Clique com o botão direito em um arquivo e escolha "Claude: Adicionar ao contexto". O conteúdo é lido na hora do envio, então vale a versão atual, mesmo sem salvar.
- **Propostas com diff.** Quando a resposta traz código, a extensão avisa e deixa você abrir um diff lado a lado para aplicar ou descartar. Nada é alterado sem a sua confirmação.
- **Barra de status.** Mostra quantos turnos há na conversa e quantos arquivos estão no contexto.

## Comandos

| Comando | Atalho | O que faz |
|---|---|---|
| Claude: Nova pergunta sobre seleção | `Ctrl+Shift+C` | Começa um pedido com o trecho selecionado |
| Claude: Continuar conversa | `Ctrl+Alt+C` | Envia outra mensagem mantendo o histórico |
| Claude: Limpar conversa | | Apaga o histórico em memória |
| Claude: Adicionar ao contexto | menu de contexto | Põe o arquivo no carrinho |
| Claude: Gerir ficheiros do contexto | | Lista e remove arquivos do carrinho |
| Claude: Limpar contexto | | Esvazia o carrinho |
| Claude: Ver alterações propostas | | Abre o diff da proposta pendente |
| Claude: Aplicar alterações | botão no diff | Grava a proposta no arquivo |
| Claude: Descartar alterações | botão no diff | Descarta a proposta |
| Claude: Estado | clique na barra de status | Menu com as ações acima |
| Claude: Cancelar pedido | | Interrompe o pedido em andamento |

No macOS os atalhos usam `Cmd` no lugar de `Ctrl`.

## Instalação

Pré-requisitos: Node.js 20+ e a CLI do Claude Code instalada e autenticada (`claude` funcionando no terminal).

```bash
git clone https://github.com/danieelaugustoo/ai-CLIte.git
cd ai-CLIte
npm install
npm run compile
```

Para testar sem instalar, abra a pasta no editor e aperte `F5`. Uma segunda janela abre com a extensão ativa.

Para instalar de vez, gere o pacote e instale pelo comando "Extensions: Install from VSIX…":

```bash
npm run package
```

## Configurações

| Configuração | Padrão | Descrição |
|---|---|---|
| `claudeCliLite.cliPath` | `"claude"` | Caminho do executável. Use o caminho completo se ele não estiver no PATH, por exemplo `C:\Users\<usuario>\AppData\Roaming\npm\claude.cmd` |
| `claudeCliLite.model` | `""` | Modelo a usar (`sonnet`, `opus`). Vazio usa o padrão da CLI. Só letras, números e `. _ : / [ ] -`; qualquer outro caractere faz o valor ser ignorado. Escopo de máquina |
| `claudeCliLite.extraArgs` | `[]` | Argumentos extras acrescentados no fim da chamada. Ignorados em workspace não confiável |
| `claudeCliLite.includeGitContext` | `false` | Se ligado, a CLI roda na pasta do projeto, e o git status (branch, autor e últimos commits) vai junto em cada pedido. Só vale em workspace confiável. Escopo de máquina |
| `claudeCliLite.alwaysPreview` | `false` | Mostra a prévia do que vai ser enviado antes de todo pedido. Por padrão ela aparece só no primeiro uso. Escopo de máquina |
| `claudeCliLite.historyMaxTurns` | `3` | Máximo de pares pergunta/resposta guardados |
| `claudeCliLite.historyMaxChars` | `20000` | Limite de caracteres do histórico. Os turnos mais antigos saem primeiro |
| `claudeCliLite.contextMaxChars` | `60000` | Acima desse total nos arquivos do contexto, a extensão pede confirmação antes de enviar |

Se a CLI não for encontrada, a extensão mostra um aviso com um botão que leva direto à configuração `cliPath`.

## Decisões de segurança

- **O prompt vai sempre pelo `stdin`**, nunca como argumento de linha de comando. Isso evita problemas de escape e injeção com aspas, `%`, `^`, `&`, `!` e quebras de linha, principalmente no Windows, onde o processo precisa de `shell: true` porque o executável do npm é um shim `.cmd`.
- **A CLI roda sem ferramentas** (`--tools ""`), sem servidores MCP (`--strict-mcp-config`) e sem gravar sessão em disco (`--no-session-persistence`). Se o evento `init` da CLI mostrar ferramentas ou MCP carregados, ou não der para conferir, o pedido é abortado.
- **A CLI não roda no seu projeto.** Por padrão ela roda numa pasta temporária vazia, apagada no fim de cada pedido, e só com as configurações do usuário (`--setting-sources user`). Assim os hooks de `.claude/settings.json` de um repositório não são executados, e o git status não vai junto. Quem quiser o git status liga `includeGitContext`.
- **`cliPath`, `extraArgs`, `model` e `includeGitContext` têm escopo de máquina**, então um repositório aberto não consegue trocar o executável, os argumentos nem o modelo pelo `settings.json` do workspace.
- **Workspaces não confiáveis** rodam em modo estrito: os argumentos extras são ignorados e a CLI usa a pasta temporária.
- **Contexto mínimo, não zero.** Além do que você escolhe (instrução, seleção e arquivos do contexto), a CLI acrescenta por conta própria instruções de sistema de alguns milhares de caracteres. Quem recebe tudo isso é o provedor que a CLI usa.
- **Windows: em revisão de segurança.** O uso de `shell: true` no Windows ainda precisa de correção, e a extensão ainda não foi verificada lá. Por enquanto, use Linux ou macOS.
- **Prévia do que vai ser enviado.** No primeiro uso (e sempre, com `alwaysPreview` ligado) a extensão abre ao lado um texto somente leitura com o modelo, a pasta de execução, os argumentos, cada arquivo do contexto e o texto exato que vai pelo `stdin`. Você escolhe Enviar ou Cancelar; ignorar o aviso conta como cancelar.
- **Segredos e caracteres ocultos.** Arquivos com cara de sensíveis (`.env`, chaves, `id_rsa`...) e arquivos de fora do workspace pedem confirmação para entrar no contexto. Antes de enviar, o contexto e a seleção passam por um scanner de chaves conhecidas e de caracteres bidi e invisíveis. Só o tipo e a linha aparecem, nunca o valor. O canal de saída e as notificações redigem chaves em claro.
- **Um pedido por vez.**

## Estrutura

| Arquivo | Responsabilidade |
|---|---|
| `src/extension.ts` | Ativação, comandos, barra de status e chamada da CLI |
| `src/prompt.ts` | Monta o texto enviado: contexto, histórico e pedido, nessa ordem |
| `src/conversation.ts` | Memória da conversa |
| `src/contextCart.ts` | Carrinho de arquivos de contexto |
| `src/proposal.ts` | Extrai blocos de código da resposta, mostra o diff e aplica ou descarta |
| `cobaia/cobaia.py` | Arquivo de teste para selecionar trechos e experimentar a extensão |

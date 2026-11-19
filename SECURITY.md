# Política de segurança / Security policy

## Português

### Versões suportadas
Só a versão mais recente (a última versão menor publicada) recebe correções de segurança.

### Como relatar uma vulnerabilidade
**Não abra uma issue pública.** Use o relato privado do GitHub:
**Security → Report a vulnerability**, neste repositório.

Inclua, se puder: a versão, o sistema operacional, os passos para reproduzir e o impacto que você viu.

### O que esperar
- Resposta inicial em até 7 dias (este é um projeto mantido por uma pessoa; o prazo é um objetivo, não uma garantia).
- Avisamos quando houver correção e, com a sua permissão, damos o crédito no registro de mudanças.
- Pedimos que você aguarde a correção antes de divulgar os detalhes.

### O que está no escopo
Execução de código a partir de um repositório aberto, vazamento de dados ou de segredos, injeção de comando, e qualquer forma de a extensão enviar ou alterar algo sem a confirmação do usuário.

### Limites que não são vulnerabilidades
O provedor de IA usado pela CLI recebe o que a CLI envia, e a própria CLI tem comportamento próprio. A extensão reduz e mostra o que envia, mas não controla o programa de terceiros.

## English

### Supported versions
Only the latest minor release receives security fixes.

### Reporting a vulnerability
**Please do not open a public issue.** Use GitHub's private reporting:
**Security → Report a vulnerability**, in this repository.

Please include the version, operating system, steps to reproduce and the impact you observed.

### What to expect
- A first reply within 7 days (this is a one-person project; the target is a goal, not a guarantee).
- We will tell you when a fix is out and, with your permission, credit you in the changelog.
- Please wait for the fix before disclosing details.

### In scope
Code execution from an opened repository, data or secret leaks, command injection, and any way for the extension to send or change something without the user's confirmation.

### Not vulnerabilities
The AI provider used by the CLI receives what the CLI sends, and the CLI has its own behavior. The extension reduces and shows what it sends, but it does not control third-party programs.

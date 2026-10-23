# Claudete

Companheira de desktop para Windows, feita com Electron. A Claudete fica na bandeja do sistema, exibe um mascote animado e oferece um painel compacto para conversar com uma sessão local do Claude Code.

## Funcionalidades

- Mascote transparente, arrastavel, com animacoes de movimento, fala, trabalho e pensamento.
- Janela click-through fora do desenho do mascote e painel de conversa ancorado ao movimento.
- Seleção de conversas locais do Claude Code, com título e projeto identificados pelo histórico local.
- Envio de mensagens pela CLI oficial do Claude Code, retomando a conversa selecionada.
- Confirmação explícita na Claudete para pedidos de aprovação de ferramentas.
- Entrada de voz e palavra de ativação opcional, conforme os serviços de fala disponíveis no Windows/Chromium.
- Seleção de arquivos e pastas para contextualizar uma mensagem.
- Ações locais de projeto com confirmação antes da execução.

## Requisitos

- Windows 10 ou posterior.
- Node.js e npm.
- Claude Code instalado e autenticado na conta da pessoa usuaria.
- Uma conversa existente no historico local do Claude Code.

## Executar em desenvolvimento

```powershell
git clone https://github.com/lorenzorafasky-cloud/claudete-desktop-companion.git
cd claudete-desktop-companion
npm ci
npm start
```

Validar a sintaxe:

```powershell
npm run check
```

Antes de enviar mensagens, autentique o Claude Code na sua própria sessão local:

```powershell
claude auth login
```

Na Claudete, selecione a conversa em `+ > Selecionar Projeto no Claude Code`. A lista é lida dos arquivos locais do Claude Code; conversas, mensagens e credenciais não são incluídas neste repositório. O envio usa a CLI instalada e a conversa selecionada. Ações que pedem aprovação aguardam uma decisão explícita na janela da Claudete.

## Dados locais e privacidade

As preferências da Claudete ficam em `app.getPath('userData')` no perfil do Windows. Históricos, conversas, credenciais e caminhos dos projetos permanecem no computador e não devem ser adicionados ao Git. A fala e o reconhecimento de voz dependem dos serviços configurados no Windows/Chromium.

Não coloque tokens, senhas, arquivos `.env`, históricos do Claude Code ou dados de projetos neste repositório. Antes de publicar alterações, revise o diff e os arquivos adicionados.

## Limitacoes

Este projeto é um protótipo desktop comunitário, não afiliado à Anthropic. A integração depende da CLI e dos recursos locais instalados; o reconhecimento de voz varia conforme o Windows, Chromium, microfone e disponibilidade do serviço. Revise cada solicitação de aprovação antes de permitir uma ação.

## Licenca

MIT. Consulte [LICENSE](LICENSE).

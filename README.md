# whatsapp-flow-agent

Agente **mínimo** que usa [**whatsapp-web.js**](https://github.com/pedroslopez/whatsapp-web.js) (sessão **WhatsApp Web** + Puppeteer), recebe mensagens de texto, chama o motor **`flow-expert`** em `POST /api/run` e responde na conversa.

**Não** usa a Cloud API oficial da Meta (sem `PHONE_NUMBER_ID` nem tokens Graph). O telemóvel liga-se por **QR code** como no WhatsApp Web.

## Requisitos

- Node 20+
- Chromium instalado no sistema **ou** definir `PUPPETEER_EXECUTABLE_PATH` (comum em Docker).
- Dependência **`flow-expert`** publicada com `flowExpert.publicBackendUrl` no `package.json` (URL HTTPS do backend). O agente e o Studio leem esse valor — não há URL no `.env` deste projecto.

## Instalação

O agente **já escuta** o WhatsApp assim que a sessão fica pronta (evento `message` do **whatsapp-web.js**): cada texto **1:1** chama `POST /api/run` no motor e a resposta volta com `msg.reply`. O painel **Integrações** do Studio não precisa de estar «Ativo» para isto.

O agente depende do pacote **`flow-expert`** (subpath `flow-expert/agent-client`). Neste monorepo a referência é `file:../flow-expert`.

**Documentação de integração** (o que fazer com o JSON de `POST /api/run`, `outputsToWhatsappText`, mídias, `baseUrl`): [../flow-expert-docs/MANUAL-ADMINISTRACAO.md](../flow-expert-docs/MANUAL-ADMINISTRACAO.md) (§10 *Cliente HTTP e agentes*). O `src/server.ts` destrutura a resposta com as mesmas funções do `agent-client` — altere o agente a partir desse padrão para novos canais.

```bash
cd ../flow-expert && npm install && npm run build
cd ../whatsapp-flow-agent
npm install
cp .env.example .env
```

### Opcional: `npm link` global

Útil quando o `flow-expert` está noutro diretório e queres a mesma cópia em vários projectos:

1. Na pasta do **flow-expert**: `npm run link:global` (compila e executa `npm link`).
2. No **whatsapp-flow-agent**: no `package.json` usa `"flow-expert": "1.0.0"` (em vez de `file:../flow-expert`), corre `npm install`, depois `npm link flow-expert`.

Com `file:../flow-expert`, `npm install` já resolve o pacote localmente; não precisas de `npm link` a menos que queiras substituir por uma instalação global.

## Variáveis de ambiente

O processo carrega **sempre** o ficheiro `.env` na **raiz deste pacote** (`whatsapp-flow-agent/.env`), com `override: true`, para não herdar por engano um `FLOW_EXPERT_API_KEY` exportado no shell a partir do servidor do Studio.

| Variável | Descrição |
|----------|-----------|
| `PORT` | Porta do HTTP de health do agente (default `8787`). |
| `FLOW_EXPERT_PORT` | Porta em que corres o `flow-expert studio` nesta máquina (default típico `5173`), para não confundir com `PORT`. |
| `FLOW_EXPERT_WORKSPACE` | Query `workspace` (default `default`). |
| `FLOW_EXPERT_API_KEY` | **Obrigatório:** Bearer para `POST /api/run` — chave emitida pelo backend cujo URL está em `flowExpert.publicBackendUrl` no pacote `flow-expert`. |
| `WHATSAPP_SESSION_PATH` | Pasta da sessão `LocalAuth` (default `.wwebjs_auth`). |
| `PUPPETEER_EXECUTABLE_PATH` | Caminho para o Chromium (opcional). |
| `WHATSAPP_IGNORE_GROUPS` | `true` (default) ignora grupos; `false` também processa `@g.us`. |

Com **1 a 3 opções** no último passo `input_prompt`, o agente envia **botões nativos** do WhatsApp (como “Sim / Não”); com **mais de 3**, mantém a lista numerada em texto (limite da API de botões = 3).

## Correr

```bash
npm run dev
```

Na primeira execução aparece um **QR no terminal** — escaneie com o WhatsApp. A sessão fica em `WHATSAPP_SESSION_PATH` (não commite).

Produção:

```bash
npm run build
npm start
```

## Integração com o fluxo

- `userId` enviado ao motor: `wa:<número>` (sem sufixo `@c.us`).
- Só mensagens de tipo `chat` (texto simples).
- Resposta: concatenação das saídas `message` / `input_prompt` do `flow-expert` (como no cliente HTTP).

## Avisos

- **Termos de uso** do WhatsApp: automação via Web não é cenário oficialmente suportado; uso por vossa conta e risco.
- Em produção use máquina dedicada, monitorização e `health` HTTP.
- Não commite `.wwebjs_auth/` nem `.env`.

## Repositório

Pode viver num **repositório Git separado** do `flow-expert`. O cliente HTTP vem de `flow-expert/agent-client`; o URL do motor vem de `flow-expert/public-backend` (campo `flowExpert.publicBackendUrl` no `package.json` do pacote publicado).

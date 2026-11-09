# APK Lab Node Service

**Documentação completa, referência da API e receitas: https://madmax-dev-br.github.io/apk-lab-node-service/**

Rode APKs Android reais num servidor Node.js com o runtime público do [APK Web Lab](https://madmax-dev-br.github.io/apk-browser-lab-site/) (uma VM Dalvik em JavaScript). Dois serviços:

- **runner** (`services/runner`) — carrega o APK de fato: uma VM por sessão, e uma API HTTP com tudo o que o site faz (Controles, mocks de endpoints, redirecionamento de hosts, permissões, retornos de métodos, Activities ignoradas, dispositivo, logcat, rede, limites de layout, capturas PNG, inspeção de ViewModels, plugins);
- **fila** (`services/queue`) — organiza o uso dos runners: jobs declarativos com passos e resultados, leases interativos, prioridades, justiça por cliente, capacidade, retentativas, cancelamento e retenção.

> English summary at the end.

## Arquitetura

```mermaid
flowchart LR
  C[Clientes<br/>CI, scripts, painel] -->|Bearer token| Q[Fila<br/>services/queue]
  B[Painel no navegador] -->|CORS opcional| Q
  Q -->|/health, /sessions| R1[Runner 1<br/>services/runner]
  Q --> R2[Runner 2]
  subgraph R1
    W1[worker_threads<br/>VM da sessão A<br/>runtime/apk-worker.js]
    W2[worker_threads<br/>VM da sessão B]
    P[plugins em workers<br/>CanvasKit para capturas]
  end
  W1 -->|HTTP do app: mocks, allow list,<br/>redirecionamento, offline| N[(Rede)]
```

Cada sessão roda o `runtime/apk-worker.js` do bundle público **sem modificações** num `worker_threads.Worker`, com uma camada mínima (`services/runner/vm-worker.mjs`) que dá a ele os globais de um Web Worker. O runner conversa com esse Worker pelo `APKWorkerClient` do próprio bundle, então toda funcionalidade passa pelo mesmo protocolo que o site e o player usam. O modelo de "Mostrar limites de layout", o host de plugins e os validadores dos Controles também são módulos do site; as capturas são compostas com o CanvasKit do bundle.

## De onde vem o runtime

Este repositório não contém o código do lab. `npm run fetch-runtime` baixa o build público de um **commit fixo** do repositório [`madmax-dev-br/apk-browser-lab-site`](https://github.com/madmax-dev-br/apk-browser-lab-site) (hoje a revisão `93d82df0437e`, commit `624ab3cb`) e confere o **SHA-256 de cada arquivo** contra `runtime.lock.json` antes de instalar em `vendor/apk-lab/` (ignorado pelo git). São ~111 MiB: `runtime/`, `framework-aosp/`, `framework-resources/`, `vendor/`, `fonts/`, `licenses/`, `THIRD_PARTY.md` e os módulos de página que os serviços importam. O site não publica APKs: os serviços rodam os APKs que você envia.

```sh
npm run fetch-runtime                      # baixa e confere
npm run fetch-runtime -- --verify          # só confere vendor/apk-lab
npm run fetch-runtime -- --from ../dist    # copia de um build local, conferindo os hashes
APK_LAB_RUNTIME_DIR=/caminho/do/dist npm run start:runner
```

Mantenedores atualizam o lock com `node scripts/make-runtime-lock.mjs <checkout do site> --commit <sha>`.

## Início rápido

Requisitos: Node 22 ou mais novo. Nenhuma dependência npm.

```sh
npm run fetch-runtime
RUNNER_TOKEN=troque-este-token-do-runner npm run start:runner                     # porta 8081
QUEUE_CLIENTS=equipe:troque-este-token-do-cliente QUEUE_RUNNERS=http://127.0.0.1:8081 \
  QUEUE_RUNNER_TOKEN=troque-este-token-do-runner npm run start:queue                # porta 8080

curl -s -H "Authorization: Bearer troque-este-token-do-runner" \
  -F apk=@app.apk -F 'config={"launch":true}' http://127.0.0.1:8081/sessions
```

Com Docker: crie um `.env` com `RUNNER_TOKEN=...` e `QUEUE_CLIENTS=equipe:...` e rode `docker compose up --build` (só a fila é publicada, em 127.0.0.1:8080).

### Variáveis de ambiente

| Runner | Padrão | |
|---|---|---|
| `RUNNER_TOKEN` | — | Token Bearer (obrigatório; `RUNNER_AUTH=off` só para uso local) |
| `RUNNER_HOST`, `RUNNER_PORT` | 127.0.0.1, 8081 | |
| `RUNNER_MAX_SESSIONS` | 2 | sessões simultâneas |
| `RUNNER_MAX_APK_MB` | 200 | |
| `RUNNER_IDLE_TIMEOUT_S`, `RUNNER_SESSION_MAX_S` | 600, 3600 | fecha sessões ociosas / antigas |
| `RUNNER_VM_HEAP_MB`, `RUNNER_VM_HEAP_MAX_MB` | 2048, 6144 | heap V8 do Worker de cada sessão |
| `RUNNER_MAX_MEMORY_MIB` | 2048 | maior `config.memoryMiB` aceito |
| `RUNNER_MIN_FREE_MB` | 0 | recusa sessões com pouca memória livre |
| `RUNNER_LOAD_TIMEOUT_S`, `RUNNER_OPERATION_TIMEOUT_S` | 120, 45 | |
| `RUNNER_ALLOWED_HOSTS` | (vazio = só mocks) | hosts que uma sessão pode liberar / redirecionar |
| `RUNNER_ALLOW_PLUGINS` | 0 | `1` habilita plugins (código do cliente no servidor) |
| `RUNNER_PLUGIN_MAX`, `RUNNER_PLUGIN_HEAP_MB`, `RUNNER_PLUGIN_BUSY_S`, `RUNNER_PLUGIN_MAX_RUN_S`, `RUNNER_PLUGIN_MAX_CODE_KB` | 4, 64, 5, 0, 256 | limites dos plugins |
| `RUNNER_APP_DATA_DIR` | (vazio) | persiste dados dos apps entre sessões, por `X-Client-Id` |
| `RUNNER_CORS_ORIGINS` | (vazio) | origens de navegador aceitas |
| `APK_LAB_RUNTIME_DIR` | vendor/apk-lab | |
| `RUNNER_LOG` | info | |

| Fila | Padrão | |
|---|---|---|
| `QUEUE_CLIENTS` | — | `id:token[:máx simultâneo]`, separados por vírgula |
| `QUEUE_HOST`, `QUEUE_PORT` | 127.0.0.1, 8080 | |
| `QUEUE_RUNNERS`, `QUEUE_RUNNER_TOKEN` | — | URLs dos runners (`url\|token` para token próprio) |
| `QUEUE_MAX_PER_CLIENT`, `QUEUE_MAX_QUEUED_PER_CLIENT` | 2, 50 | |
| `QUEUE_MAX_ATTEMPTS` | 3 | retentativas por falha de runner |
| `QUEUE_MAX_APK_MB`, `QUEUE_APK_URL_HOSTS` | 200, (vazio) | `apkUrl` só de hosts listados |
| `QUEUE_JOB_TIMEOUT_S`, `QUEUE_LEASE_MAX_S`, `QUEUE_LEASE_IDLE_S` | 900, 1800, 300 | |
| `QUEUE_RESULT_TTL_S` | 86400 | retenção de resultados |
| `QUEUE_DATA_DIR`, `QUEUE_STORE`, `QUEUE_STORE_FILE` | ./data/queue, memory, — | `file` = arquivo JSON |
| `QUEUE_ALLOW_PLUGINS`, `QUEUE_CORS_ORIGINS`, `QUEUE_HEALTH_INTERVAL_S`, `QUEUE_LOG` | 0, —, 5, info | |

## API

Referência completa com exemplos de requisição e resposta: **[documentação](https://madmax-dev-br.github.io/apk-lab-node-service/#api-runner)**. Resumo:

**Runner** (`Authorization: Bearer $RUNNER_TOKEN`; `/health` é público)

| | |
|---|---|
| `GET /health`, `GET /stats`, `GET /plugin-templates` | capacidade, revisão do runtime, modelos de plugin |
| `POST /sessions` | APK (multipart `apk`+`config`, binário + `X-APK-Config`, ou JSON `apkBase64`) → sessão carregada |
| `GET /sessions`, `GET\|DELETE /sessions/:id`, `GET /sessions/:id/inventory` | |
| `GET\|PATCH /sessions/:id/config`, `POST /sessions/:id/restart` | Controles ao vivo; chaves de reinício |
| `POST /sessions/:id/launch\|intent\|back\|tap\|type\|scroll\|wait\|input` | navegação e entrada (seletores ou coordenadas) |
| `GET /sessions/:id/snapshot\|layout-bounds\|elements\|compose-tree\|screen-state\|diagnostic` | leitura da tela e Resumo |
| `GET /sessions/:id/screenshot.png`, `GET /sessions/:id/elements/:key/screenshot.png` | PNG da tela / de um elemento |
| `GET /sessions/:id/activity\|view-models\|fragments\|methods`, `POST /sessions/:id/inspect\|field` | inspeção da VM |
| `GET /sessions/:id/logcat\|network` (+ `/stream`), `GET /sessions/:id/events` | logs paginados e SSE |
| `GET /sessions/:id/permission-requests`, `POST .../permission-requests/:rid`, `POST /sessions/:id/app-data/clear` | |
| `GET\|PUT /sessions/:id/plugins`, `GET /sessions/:id/plugins/stream\|:pid`, `POST .../plugins/:pid/stop\|restart` | plugins |

**Fila** (`Authorization: Bearer <token do cliente>`)

| | |
|---|---|
| `GET /health`, `GET /runners`, `GET /stats` | |
| `POST /jobs`, `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events`, `GET /jobs/:id/artifacts/:name`, `DELETE /jobs/:id` | jobs com passos |
| `POST /leases`, `GET /leases/:id`, `POST /leases/:id/extend`, `DELETE /leases/:id`, `* /leases/:id/session/<caminho>` | sessão interativa via proxy |

Passos de um job: `launch`, `intent`, `wait`, `tap`, `type`, `scroll`, `back`, `sleep`, `screenshot`, `layoutBounds`, `snapshot`, `elements`, `viewModels`, `viewModelField`, `inspect`, `field`, `composeTree`, `config`, `logcat`, `network`, `plugins`, `diagnostic`, `screenState`.

## Exemplos

- [`examples/apk-lab-client.mjs`](examples/apk-lab-client.mjs) — cliente Node sem dependências (runner, fila, leases, SSE);
- [`examples/run-job.mjs`](examples/run-job.mjs) — envia um job e salva os artefatos;
- [`examples/curl.sh`](examples/curl.sh) — um passeio pela API com curl;
- as 15 [receitas da documentação](https://madmax-dev-br.github.io/apk-lab-node-service/#receitas) (mock de endpoint, erro com atraso, redirecionamento, allow list/offline, permissões, retornos de método, Activities ignoradas, dispositivo ao vivo, deep link, job, lease, SSE, plugin, captura de elemento, CORS).

```js
import { readFile } from 'node:fs/promises';
import { RunnerClient } from './examples/apk-lab-client.mjs';
const runner = new RunnerClient({ url: 'http://127.0.0.1:8081', token: process.env.RUNNER_TOKEN });
const session = await runner.createSession(await readFile('app.apk'), {
  launch: true,
  endpointMocks: [{ method: 'GET', url: 'https://api.exemplo.com/v1/perfil', status: 200,
    headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{"nome":"Maria"}' }],
});
await session.tap({ selector: { testTag: 'perfil' } });
await session.wait({ textContains: 'Maria' });
console.log((await session.network()).requests);
await session.close();
```

## Segurança

- Toda a API exige token Bearer. Coloque HTTPS na frente e não exponha o runner diretamente: deixe só a fila acessível.
- O APK é entrada não confiável: rode o runner isolado (contêiner/VM sem credenciais nem acesso à rede interna). A VM interpreta bytecode em JavaScript num Worker com limite de memória; código nativo ARM não é executado.
- A rede do app começa fechada (só mocks). `RUNNER_ALLOWED_HOSTS` define o que uma sessão pode liberar e para onde pode redirecionar; liberar IPs internos ou `*` expõe sua rede ao app.
- **Plugins rodam JavaScript enviado pelo cliente no servidor** e ficam desligados por padrão. Com `RUNNER_ALLOW_PLUGINS=1`, cada plugin roda num `worker_threads` com heap limitado, ambiente vazio, num contexto `node:vm` sem `process`/`require`/`import()`/`fetch`, recebendo mensagens só como JSON, e é encerrado se ficar ocupado por mais de `RUNNER_PLUGIN_BUSY_S` segundos seguidos. **Isso não é uma fronteira de segurança** — habilite só para usuários de confiança.
- Limites em tudo: tamanho de APK e corpo, sessões, operações em espera, tempos, plugins, mocks.

## CORS

- **No navegador** (o site), as requisições do app são `fetch` da página e dependem de CORS do servidor de destino (e de Private Network Access para `localhost` a partir de uma página https); o site oferece relay, mocks e redirecionamento para contornar.
- **No runner não há CORS para a VM**: o worker de rede faz a requisição direto do Node, sujeita à política da sessão (mocks, allow list, redirecionamento, offline) e do operador. É um dos motivos para rodar no servidor.
- **A própria API** do runner e da fila responde CORS só para as origens configuradas: `RUNNER_CORS_ORIGINS=https://painel.exemplo.com,http://localhost:5173` e `QUEUE_CORS_ORIGINS=...` (padrão: nenhuma). Preflights `OPTIONS` recebem 204 com os métodos e cabeçalhos aceitos (`authorization`, `content-type`, `x-apk-config`, `x-client-id`, `last-event-id`) e `Access-Control-Allow-Private-Network` quando pedido; origens não listadas recebem 403. Streams SSE aceitam `?access_token=` porque `EventSource` não envia cabeçalhos. Detalhes e exemplos na [documentação](https://madmax-dev-br.github.io/apk-lab-node-service/#cors).

## Limitações

As mesmas do APK Web Lab: APIs ainda não implementadas falham com erro explícito que as nomeia (o modo tolerante `missingApis` usa stubs sempre reportados); código nativo protegido (integridade, root/emulador, criptografia, antifraude, pagamentos, attestation) não é simulado nem contornado; WebView falha explicitamente no servidor; a VM interpreta bytecode, então apps grandes levam segundos para iniciar e usam centenas de MiB por sessão; nas capturas, o texto que o site desenha com o DOM (Views XML simples) é aproximado com Roboto e drawables SVG não são desenhados; sem áudio.

## Testes

```sh
npm test                    # unitários; os que precisam do runtime/APKs são pulados sem eles
APK_LAB_TEST_APK_DIR=/caminho/dos/apks-de-teste npm test   # ponta a ponta com os APKs sintéticos do lab
```

Os testes não usam rede externa: o HTTP dos apps é respondido por mocks ou por servidores locais via redirecionamento. Os de ponta a ponta usam os APKs sintéticos de teste do lab (não incluídos neste repositório) e pulam quando `APK_LAB_TEST_APK_DIR` não está definido.

## Licença

Código deste repositório: MIT ([LICENSE](LICENSE)). O runtime baixado não faz parte do repositório e mantém as próprias licenças (veja `vendor/apk-lab/THIRD_PARTY.md` e os arquivos de licença de cada componente).

---

## English summary

**APK Lab Node Service** runs real Android APKs on a Node.js server with the public APK Web Lab runtime. The **runner** loads APKs into VM sessions (one `worker_threads` Worker per session running the bundle's unmodified `apk-worker.js` through its own `APKWorkerClient`) and exposes every feature of the site over REST + SSE: the full session config applied before the app starts (device, network allow list / host map / offline, endpoint mocks, permissions and location, method return overrides, ignored Activities, time and memory limits, app data), input (launch, intents/deep links, tap by coordinates or selector, type, scroll, back, wait), screen reading (snapshot, Compose tree, named layout bounds, server-side PNG screenshots of the screen or one element), VM inspection (ViewModels, fragments, fields), logcat and network log (paged or streamed), diagnostics, and server-side plugins with the site's `lab` API (off by default). The **queue** schedules declarative jobs (steps with outputs and artifacts) and interactive leases (a proxied runner session) across runners with priorities, per-client fairness, health-checked capacity, retries, cancellation, SSE progress and retention (in memory or a JSON file; the store interface is four methods, easy to back with a database).

Setup: `npm run fetch-runtime` (pinned public build, every file SHA-256 checked), then `RUNNER_TOKEN=… npm run start:runner` and `QUEUE_CLIENTS=id:token QUEUE_RUNNERS=http://127.0.0.1:8081 QUEUE_RUNNER_TOKEN=… npm run start:queue`, or `docker compose up --build`. Security: Bearer tokens, closed app network unless the operator allows hosts, plugins run client JavaScript on the server and must only be enabled for trusted users. CORS: none for the VM on the server; the services' own APIs answer CORS only for configured origins. Full docs and 15 copyable recipes: https://madmax-dev-br.github.io/apk-lab-node-service/. License: MIT for this code; the downloaded runtime keeps its own licenses.

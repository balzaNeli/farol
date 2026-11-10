# Farol

Espelhe a tela do PC **e o áudio do sistema** para um dispositivo na mesma rede Wi-Fi, direto no navegador.
Sem conta, sem nuvem, nada para instalar no visualizador, e nenhum tráfego que saia da rede local.

🇬🇷 **English version:** [README-EN.md](README-EN.md)

Foi feito para o caso em que o Deskreen fica enrolado: uma **Amazon Fire TV rodando Silk com controle
remoto (D-pad)** como tela. Celulares e tablets funcionam, mas toda decisão é tomada para a Fire TV
primeiro — sem teclado, sem touch, sem câmera, SoC fraco — e não pode quebrar os outros.

> **Status: funcional, pré-lançamento.** O servidor LAN, emparelhamento, sinalização, a IU do host
> Electron (URL/PIN/QR), o motor de captura e o visualizador estão escritos e testados. Não há
> instalador nem release oficial ainda. Veja [Status](#status).

## Como funciona

```
   host PC                                          visualizador (Fire TV · celular · tablet)
 ┌────────────────────────────────┐                ┌──────────────────────────────────┐
 │ Janela host Electron (file://) │                │ navegador, sem instalação, sem app │
 │  · tela + áudio do sistema     │                │  · WebRTC somente-recebimento    │
 │  · captura de tela, H.264      │                │  · um <video>, D-pad ou toque    │
 └───────────────┬────────────────┘                └───────────────┬───────────────────┘
                 │ IPC                                             │ HTTP + WebSocket
 ┌───────────────▼─────────────────────────────────────────────────▼──────────────────┐
 │ servidor Node embarcado — 0.0.0.0:<porta>                                          │
 │   GET  /            página do visualizador   POST /api/pair   PIN → token          │
 │   WS   /ws          retransmissor de sinalização (offer/answer/ICE; nunca faz     │
 │                     parse de SDP)                                                 │
 │   GET  /probe       sonda de hardware, para quando a TV se comporta mal          │
 └────────────────────────────────────────────────────────────────────────────────────┘
        a mídia nunca toca no servidor: WebRTC flui host ⇄ visualizador, ponto a ponto
```

O emparelhamento funciona assim: a janela host mostra uma URL, um QR code e um PIN de 6 dígitos.
O visualizador envia o PIN por HTTP na LAN, recebe um **token de uso único** e abre um WebSocket com
ele. O servidor retransmite o aperto de mãos SDP/ICE entre host e visualizador e sai de cena — o
vídeo e o áudio viajam diretamente entre os dois dispositivos.

## Status

| Peça | Estado |
|---|---|
| Servidor LAN: servir arquivos estáticos, `/api/info`, `POST /api/pair`, retransmissor `/ws` | **feito**, suíte verde |
| Loja de emparelhamento: TTL do PIN, rotação, lockout de 3 tentativas, tokens de uso único | **feito** |
| Página de sonda em `/probe` para perguntas sobre hardware real | **feito**, e decidiu o transporte |
| Casca do host Electron: janela, permissões, IPC, socket do host | **feito**, verificado na janela real (Tarefa 8) |
| Motor de captura do host: `getDisplayMedia`, H.264 primeiro, fiação do peer | **feito**, verificado com peer falso (Tarefa 9) |
| IU do visualizador: PIN pad, `<video>`, controles remotos, `?debug=1` | **feito**, verificado no Edge e na Fire TV (Tarefa 10 / Checkpoint 3) |
| IU do host: URLs de LAN, contagem regressiva do PIN, QR, status do visualizador, controles de fonte/qualidade/áudio, texto de falha | **feito**, verificado sobre CDP e com scan de celular (Tarefa 11) |
| Refinamento do visualizador: fallback de autoplay, teclas de atalho, controles, overscan, reconnect com reinício de ICE | **feito**, verificado sobre CDP (Tarefa 12) |
| Passe de segurança/README: cabeçalhos/CSP em toda rota, nenhum vazamento de PIN/token, solução de problemas | **feito**, `tests/security.test.ts` (Tarefa 13) |

O que você pode rodar hoje: o host e o visualizador completos. A janela host mostra todas as URLs de
LAN, o PIN rotativo e o QR code; escaneie o QR com um celular ou digite o PIN na Fire TV. O
visualizador percorre todo o ciclo parear → stream → silenciar/tela cheia/parar, incluindo o fallback
de autoplay silenciado e a tela de reconectar; o endpoint de emparelhamento ainda pode ser exercitado
com `curl`. `npm run serve` roda o servidor LAN e o visualizador sem o host Electron (o PIN é
impresso no terminal), então é uma ferramenta de protocolo/dev, não o produto de espelhamento.

## Requisitos

- **Node.js 24+** — o código-fonte e os testes rodam TypeScript sem etapa de compilação.
- **Windows** para áudio do sistema (o Electron só expõe `audio: 'loopback'` lá hoje). No macOS e
  Linux o app roda **apenas vídeo** e avisa isso.
- Uma **LAN** onde os dispositivos consigam se alcançar: nada de rede de convidados, nada de
  isolamento AP/cliente.
- Para o alvo primário: uma Fire TV com Silk. A referência medida é uma `AFTCA002`.

## Início rápido

```bash
npm install
npm run build        # compila src/ para dist/ e empacota as duas SPAs
npm start            # host Electron: captura, URLs de LAN, PIN e QR
# ou, sem Electron:
npm run serve        # servidor LAN na porta 4680 (PORT=4681 para mudar), imprime o PIN
```

A janela host mostra o QR, as URLs de LAN e o PIN. Escaneie o QR com um celular, ou abra a URL na
Fire TV e digite o PIN. `http://<lan-ip>:4680/probe` é a sonda de hardware; ela roda as verificações
seguras (1–4) a partir de um único botão. `npm run serve` roda o visualizador e a API sem captura
(o PIN é impresso no terminal), para verificações de protocolo.

### Fire TV (primeira vez)

1. Na Fire TV, abra o Silk e digite a URL de LAN que o host mostra (`http://<lan-ip>:4680/`).
2. Marque essa página como favorita no Silk. O rótulo exato do menu varia conforme a versão do Fire OS e do Silk.
3. Depois, abra o favorito e digite o PIN de seis dígitos; o sexto dígito envia. O QR code é para celulares/tablets, não para o controle remoto da TV.

O endpoint de emparelhamento, à mão:

```bash
# Shell POSIX, Git Bash, WSL
curl -X POST http://127.0.0.1:4680/api/pair \
  -H "content-type: application/json" -d '{"pin":"482720"}'
```

```powershell
# Windows PowerShell — verificado no PS 5.1, que mele aspas internas ao passar para o
# curl.exe nativo (o JSON chega como {pin:482720} e o servidor, com razão, chama de bad_request).
# O Invoke-WebRequest não tem esse problema, e o catch imprime o corpo do erro:
$body = '{"pin":"482720"}'
try   { (Invoke-WebRequest -Method Post -Uri http://127.0.0.1:4680/api/pair -ContentType application/json -Body $body -UseBasicParsing).Content }
catch { (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() }
```

De qualquer forma: `200 {"token":"…"}` · `401 {"error":"invalid_pin","attemptsLeft":2}` ·
`429 {"error":"locked","retryAfterMs":…}` · `409 {"error":"busy"}` ·
`400 {"error":"bad_request"}` para corpo malformado. Substitua pelo PIN que o servidor imprimiu.

`npm start` lança o casulo Electron contra o `dist/` existente; rode `npm run build` primeiro.
`npm run dev` constrói uma vez, então reconstrói os pacotes web à medida que mudam e lança o Electron
(main/preload não são vigiados, então reinicie-o depois de editar o processo principal).
`npm run serve` mantém o servidor disponível sem Electron, para sondas e verificações de emparelhamento.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run verify` | lint + teste + build. **Este é o gate** — não há CI, rode antes de cada commit |
| `npm test` | suíte inteira (`node --test`). A forma com glob é obrigatória |
| `npm run coverage` | o mesmo, com números de linha/ramo |
| `npm run lint` | `eslint . --max-warnings 0` — zero avisos permitidos |
| `npm run build` | `tsc` para main/preload/server → `dist/`, então Vite para renderer e visualizador |
| `npm start` | casulo host Electron contra o `dist/` existente (construa primeiro) |
| `npm run dev` | constrói uma vez, então reconstrói os pacotes web à mudança e lança o Electron |
| `npm run serve` | servidor LAN sozinho, sem Electron (`PORT=` sobrescreve) |
| `npm run dist` | empacota o instalador Windows (NSIS) em `release/` |

## Modelo de privacidade e segurança

O ponto inteiro é que nada sai de casa, então as regras são rígidas e escritas:

- **Sem STUN, sem TURN, sem nuvem.** `RTC_CONFIG.iceServers` está vazio e congelado, afirmado por
  teste de unidade (e, a partir da Tarefa 14, por um gate `grep` no `verify`). Peer-to-peer é apenas
  tentado na LAN, o que é por que o app é inútil fora dela — por projeto.
- **A janela host é `file://`, nunca servida na LAN.** Ela mostra o PIN; se estivesse em `0.0.0.0`,
  qualquer dispositivo na rede poderia ler o PIN carregando uma URL.
- **O visualizador é somente-recebimento.** Ele nunca chama `getUserMedia`/`getDisplayMedia`, nunca
  pede uma permissão, e nunca faz feature-detect de `navigator.mediaDevices` — o Silk esconde esse
  objeto em uma TV sem câmera, que é a origem do mito "Silk não tem WebRTC". O peer connection está
  lá. Esta regra é um `grep` gate também.
- **Um visualizador por vez.** Um segundo emparelhamento é recusado (`409`) enquanto uma sessão está
  ao vivo.
- PIN: 6 dígitos, TTL de 60 s, expira, rotaciona no sucesso e na terceira falha, então um lockout de
  60 s. Tokens: 32 bytes aleatórios, de uso único na conexão WebSocket, descartados com a conexão.
  O PIN nunca aparece em um corpo de resposta, em uma linha de log, ou no disco.
- O **socket do host** adicionalmente precisa de um token secreto por boot *e* deve vir do loopback,
  então um visualizador nunca pode reivindicar o papel de host.
- **Limite aceito: HTTP é simples.** Qualquer um que possa farejar o Wi-Fi pode ler o PIN e o token
  durante a janela de 60 s. Este é o modelo de ameaça da LAN doméstica; TLS com certificado
  auto-assinado em um navegador de TV foi julgado não valer o atrito.
- **Aceito: o QR é um segredo fotografável.** Qualquer um que possa ver a tela do host pode ler o
  mesmo PIN nele, então o QR não é mais fraco que os dígitos; o TTL de 60 s e o token de uso único
  limitam o dano.
- **Aceito: o áudio do sistema é a mixagem de todo o sistema.** Compartilhar uma janela ainda envia
  cada som de notificação. Captura por aplicativo está fora do escopo do v1.

## Limites conhecidos

Estes são reais, medidos e documentados de propósito — a parte interessante de uma ferramenta de
espelhamento é onde ela quebra:

- **A Fire TV nunca deve codificar.** Duas sondas de loopback a 720p30 congelaram uma `AFTCA002`
  o suficiente para precisar de um ciclo de energia (um teste de streaming por chunk MSE e um WebRTC).
  O dispositivo não tem folga para nada além de decodificar-e-exibir, que é exatamente o que ele faz
  aqui. Veja `docs/manual-tests.md`.
- **O teto de recebimento ainda não está travado:** o Checkpoint 3 transmitiu 1080p30, mas não segura
  30 fps estável; 720p30 é o fallback. Ajuste é um acompanhamento da Tarefa 14.
- **Áudio do sistema é apenas no Windows** e é a **mixagem de todo o sistema**, não por aplicativo:
  compartilhar uma janela ainda envia cada som de notificação. A IU não finge o contrário.
- **`navigator.mediaDevices` está escondido** no Silk, então qualquer captura futura do lado do
  visualizador (voz, capturas de tela) está fora de questão neste dispositivo.
- **A renderização acelerada do Silk** pode quebrar outros recursos da plataforma web em alguns
  modelos de Fire TV; desligar essa configuração é o workaround documentado.
- A URL da Fire TV deve ser digitada uma vez com o controle remoto — marque-a como favorita.
- Políticas de autoplay do navegador podem precisar de um toque no visualizador antes do som ser
  audível (Safari no iOS, em particular). O vídeo continua tocando mudo; foque "Press OK for sound"
  e aperte OK/Enter, ou toque nele em um celular, para ativar o som.
- **Isolamento AP/cliente ou uma rede de convidados mata isso** — sem rota, sem stream. Sintoma e
  diagnóstico ficam nas notas de solução de problemas.
- O Windows Firewall pede permissão na primeira execução.
- Um reinício de ICE falhado mostra uma tela de reconectar e retorna ao PIN pad; reemparelhar não
  recarrega a página. Um teste físico de queda de Wi-Fi ainda está pendente.
- No máximo um visualizador, uma tela por vez. Captura de microfone, transferência de arquivos,
  quadro branco, múltiplos visualizadores e travessia de internet são não-goals explícitos do v1.

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Nada carrega na TV | O Firewall do Windows bloqueou o app, ou os dispositivos estão em redes diferentes | Permita o app (Electron, ou Node para `npm run serve`) em redes **Privadas** quando o Windows pedir; se o prompt foi dispensado, adicione uma regra de entrada para o app e a porta impressa (4680 por padrão). Use a URL de LAN exata que o host imprime; um perfil de rede Pública bloqueia |
| A página carrega mas o stream nunca inicia, ou congela após alguns segundos | Isolamento AP/cliente, rede de convidados, VPN no host, ou um roteador que bloqueia ponto a ponto | Coloque ambos os dispositivos na mesma SSID não-convidada, desligue a VPN do host, e cheque a configuração de isolamento de clientes do roteador. O host desativa o esconderijo de candidatos mDNS do Chromium para que seus candidatos sejam IPs de LAN reais, mas um roteador que bloqueia multicast ou um visualizador que só oferece `.local` ainda pode falhar; não há fallback TURN por projeto |
| O Silk mostra página em branco, vídeo preto ou controles deslocados | Renderização acelerada do Silk em alguns modelos de Fire TV | Desligue a renderização acelerada nas configurações do Silk (o rótulo do menu varia pela versão do Fire OS), recarregue o visualizador, e tente `/probe` para confirmar WebRTC |
| O vídeo toca mas não há som | O navegador/TV bloqueou autoplay sem som | O vídeo continua tocando mudo. Foque **Press OK for sound** e aperte OK/Enter, ou toque em um celular. No iOS, um toque |
| O host diz "Áudio do sistema indisponível neste sistema. Apenas vídeo." | Captura de loopback do Electron é apenas no Windows | Esperado no macOS/Linux; este é o caminho apenas vídeo. No Windows esta mensagem não deve aparecer. Para áudio mudo no Windows, cheque o dispositivo de saída e o volume do app no misturador, então reinicie a captura com áudio habilitado |
| Travamento ou apresentação de slides em vez de vídeo | O link está saturado, ou o codec não é H.264 | Cheque `?debug=1` para H.264 e 720p/1080p; feche outro tráfego ou baixe a qualidade. A Fire TV decodifica; ela nunca deve codificar |
| A TV ficou sem resposta durante testes | Ela foi solicitada a codificar por uma sonda | Faça ciclo de energia e não reexecute as sondas 4b ou 6 naquele dispositivo |

## Testes

```bash
npm run verify     # lint + testes + gate de cobertura + build + gates sem-STUN/somente-recebimento
npm run coverage   # >=90% de linhas nos quatro módulos puros
```

A suíte roda TypeScript diretamente no Node 24 (`node --test`), inicia **servidores reais na porta 0**
e conversa com eles por conexões HTTP e WebSocket reais — nada do nosso é mockado, porque os mocks
são o que estaria errado. `npm run coverage` reporta os quatro módulos puros e falha abaixo de 90%
de linhas; `npm run verify` também escaneia `src/` e `dist/` em busca de um `iceServers:` não vazio
e de APIs de captura no visualizador.

Tudo que depende de uma tela real, um link Wi-Fi real e uma TV real é logado em
`docs/manual-tests.md`, incluindo as execuções que congelaram o hardware. Este arquivo é a memória
do projeto: é onde "deveria funcionar" é substituído por um número.

## Roadmap

1. **Checkpoint 2** — protocolo provado sem cabeça (feito: dois peers retransmitem offer/answer/ICE
   através do servidor real; token replayado, origem estrangeira e três PINs falhados (lockout)
   todos rejeitados).
2. **Tarefas 8–10** — casulo Electron, motor de captura e app do visualizador **feito** (janela,
   permissões, IPC, socket do host, preferência H.264, qualidade/áudio ao vivo; PIN pad de D-pad,
   stream, controles e `?debug=1`).
3. **Checkpoint 3** — ponta a ponta na Fire TV: **passou funcionalmente em 2026-10-19** (emparelhamento
   só com controle remoto, stream 1080p, áudio e controles de sobreposição); tempo do primeiro frame
   e um 1080p30 travado permanecem como acompanhamento/metri­cagem.
4. **Tarefas 11–13 — feito em 2026-10-22**: IU do host (URLs de LAN, PIN rotativo, QR, status do
   visualizador, controles); refinamento do visualizador (fallback de autoplay, teclas de atalho,
   overscan, reconnect com reinício de ICE); passe de segurança/README (cabeçalhos/CSP em toda rota,
   nenhum vazamento de PIN/token, solução de problemas). **Tarefa 14** — gates de cobertura +
   restrição e a execução completa de aceitação permanecem.

## Mapa do repositório

| Caminho | O que está nele |
|---|---|
| `SPEC.md` | a fonte da verdade para comportamento (rev 5, aprovado) |
| `tasks/plan.md` | fases, checkpoints, riscos |
| `tasks/todo.md` | cada tarefa com seus critérios de aceitação |
| `docs/manual-tests.md` | resultados de hardware, regras de segurança da sonda, execuções de aceitação |
| `src/shared/` | lógica pura, livre de runtime: guarda de protocolo, escolha de codec e áudio, `RTC_CONFIG` |
| `src/server/` | toda a superfície LAN: servir estático, loja de emparelhamento, retransmissor de sinalização |
| `src/renderer/`, `src/viewer/` | as duas SPAs React: janela host (`file://`) e visualizador |
| `AGENTS.md` | notas para colaboradores que trabalham com um agente de IA: comandos, peculiaridades, não-negociáveis |

## Contribuindo

- Leia `SPEC.md` primeiro, depois `tasks/todo.md`. O comportamento é especificado antes de ser
  construído, e os três arquivos (especificação, tarefas, código) são mantidos em sintonia — um
  commit nomeia a tarefa que implementa.
- `npm run verify` deve estar verde antes de um commit, com **zero** avisos de lint e nenhum teste
  pulado ou deletado para chegar lá.
- Novas dependências de runtime precisam de uma razão muito boa: `ws` e `qrcode` são todo o orçamento.
- Não-negociáveis, em uma linha cada: o visualizador nunca captura, `iceServers` permanece vazio, a
  IU do host permanece fora da LAN, e o retransmissor de sinalização nunca faz parse de SDP.

## Licença

MIT — veja [LICENSE](LICENSE).

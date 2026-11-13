# Design doc — Estabilização H.264 1080p30 via bitrate fixo (Abordagem A)

**Data:** 2026-11-11  
**Autor:** agente de implementação (OpenCode)  
**Status:** pendente de aprovação do parceiro humano

## 1. Intent e por que

O projeto `farol` é um host Electron (Windows 11) que captura tela + áudio do sistema e envia por WebRTC para um viewer na mesma LAN (principalmente Amazon Fire TV AFTCA002 com Silk). Nada sai da rede local — sem STUN/TURN, sem codificação na Fire TV.

O sintoma relatado: quedas de quadros no stream H.264 a 1080p30, instabilidade de qualidade. A causa suspeita é o emissor (host) enviando bitrate variável sem teto, inundando o buffer de decodificação do SoC fraco da Fire TV e gerando perda de pacote na LAN. Sem feedback de recepção nem controle de bitrate, o stream não se recupera.

Esta spec implementa a **Abordagem A** (aprovada pelo parceiro): bitrate fixo conservador de **5 Mbps** para 1080p30, preservando a resolução e a regra de que o viewer é receive-only puro. A Abordagem B (telemetria + ABR leve) e a D (intervenções extremas) só entram se o limite físico da LAN provar que o A não é suficiente.

## 2. Goals

- Limitar o encoder de vídeo do host a um `maxBitrate` fixo de 5 Mbps (5.000.000 bps) no `RTCRtpSender` de vídeo, para 1080p30.
- Manter a resolução de captura em 1080p (opção b): nunca reduzir resolução como válvula de escape.
- Preservar `RTC_CONFIG.iceServers` vazio e congelado (sem STUN/TURN).
- Preservar o viewer como receive-only puro: sem `getUserMedia`, `getDisplayMedia`, `navigator.mediaDevices`, ou qualquer teste de feature de mídia no viewer.
- Instrumentar o viewer para ler `framesDecoded` e `framesDropped` dos stats de inbound-RTP (apenas sob `?debug=1`, best-effort), para saber se o A está funcionando antes de considerar a B.
- Manter todas as restrições não negociáveis do projeto (CSP strict, PIN pad de botões, host em `file://`, sinalização verbatim).

## 3. Non-goals

- Não adicionar controle adaptativo de bitrate (ABR) neste PRD — é a Abordagem B, só se o A falhar.
- Não reduzir resolução dinamicamente — a opção (b) mantém 1080p.
- Não alterar o protocolo de sinalização nem o servidor HTTP.
- Não adicionar dependências de runtime novas.
- Não executar Check 4b nem qualquer diagnóstico arriscado na Fire TV acima de 640×360 @ 15 fps por mais de 20–30 segundos, e apenas com segundo clique de confirmação no `/probe`.

## 4. Anti-goals

- Não usar `<input>` para PIN no viewer.
- Não usar `<script>` ou `<style>` inline nas páginas servidas (CSP strict).
- Não adicionar dependências de npm além das já existentes (`ws`, `qrcode`, `react`, `react-dom`).
- Não congelar a Fire TV: evitar loopback WebRTC/MSE acima dos limites estabelecidos.

## 5. Constraints (não negociáveis)

| Restrição | Fonte |
|-----------|-------|
| Viewer é receive-only; sem APIs de captura de mídia | AGENTS.md + `check:gates` |
| PIN pad é botões, nunca `<input>` | AGENTS.md |
| `RTC_CONFIG.iceServers` vazio e congelado | AGENTS.md + `check:gates` |
| CSP strict em toda resposta servida | AGENTS.md (`src/server/http.ts`) |
| Sinalização relata `Signal` frames verbatim, nunca parseia SDP | AGENTS.md |
| Host page fica em `file://`; nunca servida pelo HTTP | AGENTS.md |
| Bitrate fixo 5 Mbps para 1080p30; resolução nunca reduzida como válvula | decisão do parceiro (opção b) |

## 6. Abordagens consideradas

| Abordagem | O que propunha | Trade-offs | Por que não foi escolhida (agora) |
|-----------|----------------|------------|-----------------------------------|
| **A — Bitrate fixo 5 Mbps + GOP curto (ESCOLHIDA)** | `sender.setParameters({ encodings: [{ maxBitrate: 5_000_000, maxFramerate: 30 }] })` no host; manter `preferH264` | Simples, previsível, emissor controla, viewer fica burro | Nenhuma — é a escolha aprovada |
| B — ABR leve mantendo 1080p | Viewer lê `getStats()`, pede ao host via sinalização para subir/descer `maxBitrate` | Mais complexo, precisa de canal de retorno ao host; só se o A não bastar | Adiada para fase posterior |
| C — Ajuste de encoder (profile/level, zerolatency, simulcast) | `setCodecPreferences` já existe; profile/level e simulcast não têm API WebRTC direta | Simulcast é complexo no answerer receive-only; perfil/level não controlável via API padrão | Adiada; `preferH264` já atende o codec |

## 7. Como será feito (partes do how já decididas)

### 7.1 `src/shared/capture.ts` — constante de bitrate e parâmetros de encoding

Adicionar:
- `export const TARGET_BITRATE_BPS = 5_000_000` — 5 Mbps, o teto fixo para o encoder de vídeo.
- `export function videoEncodingParams(maxBitrateBps: number): RTCRtpEncodingParameters` — retorna `{ maxBitrate: maxBitrateBps, maxFramerate: 30 }`. O `maxFramerate: 30` espelha o cap de captura e garante que o sender não exceda 30 fps.

`videoConstraints` permanece inalterado (continua aplicando `width`/`height`/`frameRate` via `applyConstraints` no track de captura).

Além disso, o track de captura deve receber `video.contentHint = "motion"` (substituindo o `"detail"` atual em `mirror.ts` linha ~151). A dica `"motion"` instrui o Chromium do Electron a derrubar qualidade visual, em vez de derrubar quadros, quando o encoder estiver pressionado — complementando o teto de bitrate fixo.

### 7.2 `src/renderer/mirror.ts` — aplicar `setParameters` no sender de vídeo

O `maxBitrate` injetado via `RTCRtpSender.setParameters()` afeta apenas o empacotador/encoder de mídia local — **não trafega dentro do SDP da oferta** e, portanto, não altera a negociação do peer. O fluxo correto é:

1. Obter os parâmetros atuais do sender com `sender.getParameters()`.
2. Injetar `maxBitrate: TARGET_BITRATE_BPS` dentro da array `encodings` (substituindo ou acrescentando a entrada de vídeo).
3. Aplicar de volta com `sender.setParameters(updated)`.

Isso ocorre:
1. No `start()`, após `peer.addTrack(video, capture)` e após o sender de vídeo existir, obtido via `peer.getSenders().find((s) => s.track === video)` (ou via o transceiver já criado). A aplicação acontece **após a track estar ativada e antes ou logo depois do pareamento estar completo** — não depende da oferta ter sido enviada.
2. No `setQuality()`, quando a qualidade muda, para reaplicar os parâmetros de encoding (o bitrate permanece 5 Mbps, mas o `maxFramerate` e quaisquer ajustes futuros são reaplicados).

O `setParameters` retorna uma `Promise`; falhas aqui são best-effort (não devem derrubar a captura, apenas logar via `emit` de erro não crítico).

**Decisões de design tomadas durante a implementação:**

1. **Falha no teto de bitrate no `start()` não aborta o stream.** Se `applyVideoBitrateCap` falhar (ex. Chromium rejeita `maxBitrate`), `start()` emite um erro não-crítico via `emit({ error: `Bitrate cap not applied: ...` })` mas continua normalmente e retorna `{ ok: true }`. A transmissão começa sem o teto de 5 Mbps, mas não é impedida de iniciar. Isso prioriza a disponibilidade do stream sobre o teto absoluto no caminho de inicialização.

2. **O preset `native` não impõe limite de framerate/bitrate no sender.** Quando `quality === "native"`, o helper `applyVideoBitrateCap` retorna cedo sem injetar `maxBitrate` nem `maxFramerate` via `setParameters`, deixando a fonte exatamente como entregue pelo `getDisplayMedia`. Isso é intencional: `"native"` significa "deixe a fonte em paz" (conforme comentário em `capture.ts`), e o teto de 5 Mbps só se aplica a `"1080p"` e `"720p"`.

### 7.3 `src/viewer/Watch.tsx` — telemetria de decodação (debug only)

O bloco `?debug=1` já lê `inbound-rtp` de vídeo e extrai `codec`, `resolution`, `fps`, `kbps`, `lost`. Acrescentar:
- `framesDecoded?: number`
- `framesDropped?: number`

Do `videoStats` (entrada `inbound-rtp` de vídeo) e exibi-los no `<pre className="watch-debug">` quando `debug` estiver ativo. Isso permite ao parceiro verificar, em tempo real, se a Fire TV está decodificando e descartando quadros, antes de decidir pela Abordagem B.

### 7.4 `src/renderer/App.tsx` — exposição opcional na UI

O seletor de qualidade já existe (`native`, `1080p`, `720p`). Não adicionar novo controle de bitrate na UI (o A é fixo). Opcional: ajustar o label de "1080p" para incluir "(5 Mbps fixo)" para deixar o comportamento transparente ao usuário. Isso é uma decisão de copy, não de comportamento.

## 8. O que fica para o builder

1. Editar `src/shared/capture.ts`: adicionar `TARGET_BITRATE_BPS` e `videoEncodingParams`.
2. Editar `src/renderer/mirror.ts`:
   - Mudar `video.contentHint = "detail"` para `video.contentHint = "motion"` (linha ~151).
   - Criar helper `applyVideoBitrateCap(sender, maxBitrateBps, quality)` que: (i) retorna cedo se `quality === "native"`; (ii) obtém `getParameters()`; (iii) injeta `maxBitrate` em `params.encodings[0]` (injetando `[{}]` se o array estiver vazio); (iv) chama `setParameters()`.
   - Chamar o helper em `start()` dentro de `try/catch`: falha emite erro não-crítico via `emit` mas não impede o início da transmissão (retorna `ok: true`).
   - Chamar o helper em `setQuality()` dentro de `try/catch`: falha emite erro e retorna `false` (reverte o rótulo na UI).
3. Editar `src/viewer/Watch.tsx`: acrescentar `framesDecoded` e `framesDropped` ao `InboundStats` e ao `DebugInfo`, ler do `videoStats` e exibir no debug.
4. (Opcional) Editar `src/renderer/App.tsx`: ajustar label de qualidade para refletir bitrate fixo.
5. Rodar `npm run verify` (lint + test + coverage + build + `check:gates`) e `npx tsc -p tsconfig.json`.
6. Verificar que `check:gates` ainda passa (sem `iceServers:` preenchido, sem capture APIs no `src/viewer`).

## 9. Aceitação de Testes Manuais

### Aceitação 1080p30 + Queda de Wi-Fi (2026-11-13)

- **Hardware:** Host Windows (branch `dev`, commit `<hash>`) → Fire TV `AFTCA002` (Silk)
- **Codec / Resolução / FPS:** H.264, 1920x1080 @ `17` fps estáveis (bitrate observado: `~4,5` Mbps)
- **Tempo até o primeiro frame:** `1` s
- **Troca de qualidade ao vivo:** `1080p30` ↔ `720p30` ↔ `native` OK (sem erros de `setParameters`)
- **Queda de Wi-Fi (15s):** Reinício de ICE falhou conforme esperado → tela de reconectar → retorno ao PIN pad → reemparelhamento OK sem reload da página
- **Resultado:** FALHOU (notas: `não ficou estável em 30 fps a 1080p`)

## 10. Aprovação

Este design doc cobre a Abordagem A e as partes do how já decididas. Nenhum código de produto será escrito até que você aprove.

Responda "aprovado" ou indique o que ajustar.
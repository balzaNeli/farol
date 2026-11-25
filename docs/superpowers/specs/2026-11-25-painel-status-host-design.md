# Design doc — Painel de status ao vivo no Host

**Data:** 2026-11-25
**Status:** abordagem A e doc aprovados pelo parceiro humano em 2026-11-25

## 1. Intenção

Tornar visível no Host, sem poluir o layout, o que a transmissão está fazendo **agora**: estado da
sessão, FPS de envio, bitrate estimado, qualidade aplicada, áudio ativo e motivo de limitação do
encoder. Tudo isso já é medido no Host; o trabalho é expor e formatar, não coletar de novo.

**Invariante:** o painel é somente leitura e local. Nenhum número cruza a sinalização, nenhum
`getStats()` novo é adicionado (especialmente no viewer), nenhum `Signal`, IPC, dependência de
runtime, fonte externa ou estilo/script inline entra no projeto. Nada aqui mexe em `iceServers`,
na válvula EX-001 ou em `applyConstraints` — resolução continua 1080p fixo na oscilação de LAN.

## 2. O que já existe (achados da leitura)

- `src/renderer/mirror.ts:397` já roda um `setInterval` de **3 s** em `videoSender.getStats()` e lê
  `outbound-rtp` (`qualityLimitationReason`, `framesEncoded`, `timestamp`) e
  `remote-inbound-rtp` (`fractionLost`). Ele calcula FPS **dentro** do callback só para o aviso de
  janela lenta e guarda `lastEncoderStats` para `getEncoderStats()`. FPS e bitrate não chegam à UI.
- `MirrorState` hoje é `{ status, error, audio, lowFpsWarning }`. `App.tsx:276` já tem um
  `.status-area` com `role="status"` e altura mínima reservada — o lugar natural para a linha.
- `release()` (`mirror.ts:210`) já limpa `statsTimer`, tracks, peer, `lastEncoderStats` e contadores.
  O ponto de higiene em aberto é `onChange()`: registra listeners num `Set` e não devolve como
  remover.
- `App.tsx:48` guarda a qualidade **selecionada**; `mirror.ts` guarda a **aplicada** em
  `lastAppliedQuality`. Se `setParameters` falha, a seleção é revertida, mas a UI não tem esse
  dado — o painel deve mostrar a aplicada.

## 3. Contrato de dados

`src/shared/capture.ts` (já no ratchet de cobertura) ganha uma decisão pura; nenhum módulo novo
é criado, pelo mesmo motivo da Fase 2:

```ts
export type SendCounters = { framesEncoded: number; bytesSent: number | null; timestamp: number };
export type SendSample = {
  framesEncoded?: number;
  bytesSent?: number;
  timestamp?: number;
  qualityLimitationReason?: string | null;
};
export type SendMetrics = { fps: number | null; bitrateBps: number | null; limitReason: string | null };

export function readSendMetrics(
  previous: SendCounters | null,
  sample: SendSample,
): { counters: SendCounters | null; metrics: SendMetrics };
```

Regras:

- `limitReason` é o `qualityLimitationReason` da amostra quando é string; `null` caso contrário.
  Não é deduzido de delta nenhum.
- `framesEncoded` e `timestamp` precisam ser números finitos para produzir FPS. `bytesSent` é
  **opcional**: sem ele, o FPS continua funcionando (os testes atuais de janela lenta não o
  fornecem, e stats pré-negociação podem omiti-lo) e só o bitrate fica `null`.
- Primeira amostra válida: guarda contadores, mas `fps`/`bitrate` são `null` — não existe janela
  de tempo para derivar taxa. Sem isso a UI mostraria um pico inventado no primeiro tick.
- Timestamp igual ou menor que o anterior, ou delta negativo (contador resetado): `null` nos dois
  campos de taxa; contadores são atualizados para a amostra atual.
- `bitrateBps = (bytesSent - bytesSent anterior) * 8 / segundos`. Valor `0` é medição válida,
  mas a UI mostra `—` para `<= 0`: antes do viewer entrar não há tráfego e `0,0 Mbps` pareceria
  falha.
- Nada arredonda dentro da função pura: formatação (`toFixed`) é responsabilidade da UI.

`MirrorState` ganha dois campos:

```ts
metrics: SendMetrics | null; // null = sem amostra ou sessão encerrada
quality: Quality;            // qualidade aplicada na captura, não a selecionada no formulário
```

`getEncoderStats()` continua intacto (API pública já usada em testes); `metrics` é o caminho novo
para a UI.

## 4. Integração no `mirror.ts`

- O timer de 3 s chama `readSendMetrics(sendCounters, sample)` **uma vez** por tick. O `fps`
  retornado substitui o cálculo local que hoje alimenta `evaluateLowFpsWarning()` — mesma coleta,
  mesma histerese do aviso, sem segundo `getStats()`.
- `sendCounters` passa a ser a única memória de frames/bytes/timestamp (substitui
  `previousFramesEncoded` e `previousTimestamp`). `release()` zera `sendCounters` e emite
  `metrics: null`; `start()` também parte de `metrics: null`, sem herdar a sessão anterior.
- `quality` é atualizado em `start()`, no sucesso de `setQuality()` e no revert por falha de
  `setParameters()`. `release()` volta para `"1080p"`. Assim o painel mostra o que o encoder
  realmente aceitou.
- `onChange(listener)` passa a devolver `() => void` (unsubscribe). Chamadores atuais que ignoram
  o retorno continuam funcionando; `App.tsx` usa o retorno no cleanup do effect. Os listeners de
  `window.mirror.onState`/`onSignal` permanecem como estão — o contrato IPC não muda.
- Nenhum timer novo. `statsTimer` continua sendo o único interval e `release()` continua limpando
  tanto ele quanto os listeners locais.

## 5. UI — `src/renderer/LiveStatus.tsx` + `host.css`

Componente presentacional pequeno, renderizado **dentro** do `.status-area` existente, abaixo da
linha de status atual:

```tsx
<LiveStatus
  status={state.status}
  quality={state.quality}
  audio={state.audio}
  metrics={state.metrics}
/>
```

- Uma `<dl className="live-status">` com cinco células: `Send`, `Bitrate`, `Quality`, `Audio`,
  `Encoder`. `dt` em caixa alta e pequeno; `dd` com `font-variant-numeric: tabular-nums`.
- Valores: `—` quando não há amostra ou sessão (`idle`, `error`), `30 fps`, `4,8 Mbps`, `1080p`,
  `On`/`Off`, e `Stable` / `Network` / `CPU-limited` conforme `limitReason` (`none` / `bandwidth`
  / `cpu`). Qualquer motivo desconhecido aparece como `—`, nunca como texto cru suspeito.
- Em `starting`/`waiting`, o FPS medido pode aparecer (a captura já está ativa); o bitrate só
  aparece com tráfego real. Nenhum valor é fabricado para preencher o painel.
- Sem `role="status"` no `<dl>`: o `<p className="status" role="status">` existente continua sendo
  a única live region, evitando anúncio duplo em leitor de tela. O `<dl>` tem `aria-label`.
- CSS usa apenas tokens locais (`--farol-*`) e `grid-template-columns: repeat(auto-fit,
  minmax(84px, 1fr))`, sem media query nova — o grid já se acomoda nos 520 px do layout mobile.
  Nenhuma fonte externa, nenhum inline style.

Cadência: "ao vivo" aqui significa **até 3 s de atraso**, a mesma do timer que já existe. Não
vamos criar interval de 1 s só para animar número — isso custaria bateria no Host e não aumentaria
a precisão da medição.

## 6. Fora de escopo

`getStats()` no viewer, nova `Signal` ou campo IPC, telemetria fora da LAN, novo timer, nova
dependência runtime, `applyConstraints` automático, mudança em `iceServers`/EX-001, testes de
componente React (o projeto não tem jsdom/Playwright; a regra pura é testada em `node:test` e o
componente passa por revisão de React).

## 7. Plano de testes (TDD, RED → GREEN)

1. `tests/adaptive.test.ts`: casos de `readSendMetrics` — sem amostra, primeira amostra, delta
   válido, `bytesSent` ausente, delta negativo, timestamp regressivo, `NaN`/infinito, `limitReason`
   nulo/desconhecido, `bytesSent === 0`.
2. `tests/mirror.test.ts`: `metrics` começa `null`; dois ticks com `bytesSent` geram FPS e bitrate;
   `stop()`/`release()` limpam e emitem `null`; unsubscribe de `onChange` interrompe emissões;
   `quality` reflete o valor aplicado e o revert em falha de `setParameters`.
3. Revisão `@react-reviewer` no novo componente e `@code-reviewer` no diff completo.

## 8. Sincronização de documentação

- `SPEC.md`: rev 8 curta descrevendo a linha de status do Host, a fonte dos números e a cadência
  de 3 s — sem alterar critérios de sucesso, contratos ou proibições existentes.
- `tasks/plan.md`: Task 18 na Fase 5, sem reabrir checkpoints fechados.
- `tasks/todo.md`: ledger da Task 18 com critérios de aceite e a ressalva da cadência.
- `CONSTRAINTS.md`: **sem mudança de regra**. Se a cobertura subir acima de 99,71%, o ratchet é
  atualizado em `package.json`, `CONSTRAINTS.md`, `tasks/todo.md` e neste doc, como na Fase 2.

## 9. Verificação e entrega

- `npm run verify` (lint sem warnings, testes, cobertura ≥ ratchet, build, `check:gates`) e
  `npx tsc -p tsconfig.json` limpos; `git diff --check` sem whitespace errors.
- Nenhum `@ts-ignore`, `eslint-disable`, teste pulado ou supressão nova.
- Alterações deixadas em stage ou commit com `--no-gpg-sign`, sem push, para assinatura manual.

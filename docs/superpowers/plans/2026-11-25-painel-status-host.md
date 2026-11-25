# Painel de status ao vivo no Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exibir no Host uma linha compacta e precisa do estado da sessão, FPS de envio, bitrate estimado, qualidade aplicada, áudio e motivo de limitação do encoder, usando somente o `getStats()` de 3 s que já existe.

**Architecture:** Uma decisão pura em `src/shared/capture.ts` deriva as taxas de deltas de contadores; `mirror.ts` publica o snapshot em `MirrorState` e devolve unsubscribe de `onChange`; `LiveStatus.tsx` renderiza o snapshot dentro do `.status-area` atual. Nenhum dado sai do Host, nenhum timer novo é criado e a máquina de estados da transmissão não muda.

**Tech Stack:** TypeScript estrito (Node 24 type stripping, sem compile step para testes), React 19 + Vite, `node:test`/`node:assert`, CSS com tokens locais.

**Spec:** `docs/superpowers/specs/2026-11-25-painel-status-host-design.md` (abordagem A aprovada em 2026-11-25). Plano de fundo: `SPEC.md` rev 7, `AGENTS.md`, `CONSTRAINTS.md`.

## Global Constraints

- `RTC_CONFIG.iceServers` continua vazio e congelado; nenhum STUN/TURN, nunca.
- Viewer rigorosamente receive-only: nenhum `getUserMedia`, `getDisplayMedia`, `navigator.mediaDevices` ou teste de feature em `src/viewer`/`dist/viewer`.
- Host permanece em `file://`; a página nunca é servida pelo servidor LAN.
- Dependências de runtime apenas `ws` + `qrcode`. `eslint-plugin-react-hooks` é devDependency (já instalada).
- Nenhum `<script>`/`<style>` inline e nenhuma fonte externa; apenas tokens `--farol-*` e arquivos CSS locais.
- Resolução nunca é reduzida como válvula de rede. EX-001: `scaleResolutionDownBy` 1.5 somente com `qualityLimitationReason === "cpu"`, 1.0 em `"none"`; `degradationPreference` permanece `"maintain-resolution"`.
- Nenhum novo `Signal`, campo IPC, `getStats()` no viewer, timer ou telemetria fora da LAN.
- Sem `@ts-ignore`, `eslint-disable`, teste pulado/deletado, stub ou segredo no diff.
- Cobertura dos módulos puros ≥ **99.71%** (ratchet; subir o piso se a cobertura aumentar); lint com zero warnings; `npx tsc -p tsconfig.json` limpo; `npm run verify` verde antes de cada commit.
- Commits com `--no-gpg-sign`, `git add` e `git commit` em comandos separados, nada pushed.
- Cadência honesta: o painel atualiza no máximo a cada **3 s**, a mesma do timer existente.

## Review Focus

- **`getStats()` sem entrada de vídeo / pré-negociação:** nenhum número inventado; `metrics === null` e a UI mostra `—`. Pinado em Task 2 (primeira amostra) e Task 3 (estado inicial).
- **`bytesSent` ausente ou zero:** FPS continua disponível, bitrate mostra `—` em vez de `0,0 Mbps`. Pinado em Task 2 (amostra sem bytes) e Task 4 (formatação).
- **Contador resetado ou timestamp regressivo:** taxas viram `null`, nunca negativas ou gigantes. Pinado em Task 2 (deltas negativos e timestamp menor).
- **`stop()` com tick de stats em voo:** contadores e timer da sessão anterior não vazam para a próxima. Pinado em Task 3 (`release()` zera e emite `null`).
- **Listener após unmount:** `onChange` devolve unsubscribe e a emissão para; sem `setState` em componente desmontado. Pinado em Task 3 (teste de unsubscribe).
- **Leitor de tela:** apenas o `<p className="status" role="status">` existente é live region; o `<dl>` novo não anuncia duas vezes. Pinado em Task 4 (revisão de React).

---

### Task 1: Especificação e registro no plano

**Files:**
- Create: `docs/superpowers/specs/2026-11-25-painel-status-host-design.md` (já escrito, revisar uma última vez)
- Create: `docs/superpowers/plans/2026-11-25-painel-status-host.md` (este arquivo)
- Modify: `SPEC.md` (rev 8 curta, após a rev 7)
- Modify: `tasks/plan.md` (Task 18 na Fase 5, sem reabrir checkpoints)
- Modify: `tasks/todo.md` (ledger da Task 18 com critérios de aceite)

**Interfaces:**
- Consumes: design doc aprovado; convenção de commits do histórico (`feat(fase2): ...`, `docs(fase2): ...`).
- Produces: `SPEC.md` rev 8 e a Task 18 como fonte de verdade para as tarefas seguintes.

- [ ] **Step 1: Conferir o design doc e escrever a rev 8 do SPEC**

Acrescentar após o parágrafo da rev 7: rev 8 (2026-11-25) descreve a linha de status do Host, alimentada pelo `getStats()` de 3 s já existente; sem novo `Signal`, sem `getStats()` no viewer, sem telemetria, sem mudança de resolução; `idle`/`error` e sem amostra mostram `—`. Não alterar critérios de sucesso, contratos ou proibições.

- [ ] **Step 2: Registrar Task 18 no plano e no ledger**

Texto da Task 18: "Painel de status ao vivo no Host: `readSendMetrics` puro, `MirrorState.metrics`/`quality`, `LiveStatus` no `.status-area`, unsubscribe de `onChange`." Critérios de aceite: gate verde com ratchet atual, componente sem `role="status"` próprio, sem timer novo, revisões de código e React sem achados críticos.

- [ ] **Step 3: Verificar a documentação e commitar**

Run: `git diff --check`
Expected: sem whitespace errors (avisos de LF→CRLF do checkout são esperados).
Run: `git add docs/superpowers/specs/2026-11-25-painel-status-host-design.md docs/superpowers/plans/2026-11-25-painel-status-host.md SPEC.md tasks/plan.md tasks/todo.md`
Run: `git commit --no-gpg-sign -m "docs(fase2): especificar painel de status ao vivo no host"`

### Task 2: Decisão pura de métricas de envio

**Files:**
- Modify: `src/shared/capture.ts` (após `nextAdaptive`, antes de `isWindowSurface`)
- Test: `tests/adaptive.test.ts` (arquivo existente, acrescentar casos no final)

**Interfaces:**
- Consumes: nada além de tipos locais; `capture.ts` já é incluído em `npm run coverage`.
- Produces:
  - `type SendCounters = { framesEncoded: number; bytesSent: number | null; timestamp: number }`
  - `type SendSample = { framesEncoded?: number; bytesSent?: number; timestamp?: number; qualityLimitationReason?: string | null }`
  - `type SendMetrics = { fps: number | null; bitrateBps: number | null; limitReason: string | null }`
  - `readSendMetrics(previous: SendCounters | null, sample: SendSample): { counters: SendCounters | null; metrics: SendMetrics }`

- [ ] **Step 1: Escrever os testes RED**

Acrescentar em `tests/adaptive.test.ts`, importando `readSendMetrics` de `../src/shared/capture.ts`:

```ts
test("readSendMetrics: primeira amostra não inventa taxas", () => {
  const { counters, metrics } = readSendMetrics(null, {
    framesEncoded: 30, bytesSent: 1_000, timestamp: 3000,
  });
  assert.deepEqual(metrics, { fps: null, bitrateBps: null, limitReason: null });
  assert.deepEqual(counters, { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 });
});

test("readSendMetrics: delta gera fps e bitrate", () => {
  const { metrics } = readSendMetrics(
    { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 },
    { framesEncoded: 60, bytesSent: 4_000, timestamp: 6000, qualityLimitationReason: "none" },
  );
  assert.equal(metrics.fps, 10);
  assert.equal(metrics.bitrateBps, 8_000);
  assert.equal(metrics.limitReason, "none");
});

test("readSendMetrics: sem bytesSent o fps continua", () => {
  const { metrics } = readSendMetrics(
    { framesEncoded: 30, bytesSent: null, timestamp: 3000 },
    { framesEncoded: 90, timestamp: 6000 },
  );
  assert.equal(metrics.fps, 20);
  assert.equal(metrics.bitrateBps, null);
});

test("readSendMetrics: timestamp regressivo e deltas negativos não produzem taxas", () => {
  const old = { framesEncoded: 30, bytesSent: 1_000, timestamp: 3000 };
  const regressive = readSendMetrics(old, { framesEncoded: 90, bytesSent: 4_000, timestamp: 2000 });
  assert.equal(regressive.metrics.fps, null);
  assert.equal(regressive.metrics.bitrateBps, null);
  const negative = readSendMetrics(old, { framesEncoded: 10, bytesSent: 500, timestamp: 6000 });
  assert.equal(negative.metrics.fps, null);
  assert.equal(negative.metrics.bitrateBps, null);
});

test("readSendMetrics: valores não finitos limpam contadores e preservam o motivo", () => {
  const { counters, metrics } = readSendMetrics(null, {
    framesEncoded: Number.NaN, bytesSent: Number.POSITIVE_INFINITY, timestamp: 3000,
    qualityLimitationReason: "cpu",
  });
  assert.equal(counters, null);
  assert.deepEqual(metrics, { fps: null, bitrateBps: null, limitReason: "cpu" });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `node --test "tests/adaptive.test.ts"`
Expected: FAIL — `readSendMetrics` não existe ainda.

- [ ] **Step 3: Implementar `readSendMetrics` em `src/shared/capture.ts`**

Exatamente a assinatura da Interfaces. Regras: `limitReason` é o motivo quando é string, senão `null`; `framesEncoded`/`timestamp` finitos são obrigatórios para qualquer taxa; `bytesSent` finito é opcional e, quando ausente, `counters.bytesSent` vira `null` e só o bitrate é `null`; sem `previous` ou com `timestamp <= previous.timestamp`, taxas `null` mas contadores atualizados; deltas negativos em frames ou bytes anulam a taxa correspondente; `fps = deltaFrames / segundos`, `bitrateBps = deltaBytes * 8 / segundos`; não arredondar.

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `node --test "tests/adaptive.test.ts"`
Expected: PASS, todos os casos novos verdes.

- [ ] **Step 5: Commitar**

Run: `git add src/shared/capture.ts tests/adaptive.test.ts`
Run: `git commit --no-gpg-sign -m "feat(fase2): derivar fps e bitrate do stats do host"`

### Task 3: Exposição no mirror e limpeza de listener

**Files:**
- Modify: `src/renderer/mirror.ts:17-22` (tipo `MirrorState`), `:49` (`onChange`), `:82-86` (estado inicial), `:136-140` (contadores), `:210-240` (`release`), `:392-462` (timer de stats), `:518-520` e `:553-589` (`quality`)
- Modify: `src/renderer/App.tsx:51-56` (somente o literal inicial de `MirrorState`, para manter `tsc` verde entre tarefas)
- Test: `tests/mirror.test.ts` (extender `videoReport`, acrescentar testes de métricas/unsubscribe)

**Interfaces:**
- Consumes: `readSendMetrics`, `SendMetrics` e `SendCounters` da Task 2.
- Produces:
  - `MirrorState` passa a ter `metrics: SendMetrics | null` e `quality: Quality` (o tipo `Quality` já é importado em `mirror.ts`).
  - `Mirror.onChange(listener: (state: MirrorState) => void): () => void`.
  - `getEncoderStats()` inalterado.

- [ ] **Step 1: Extender o helper de teste e escrever os testes RED**

Em `tests/mirror.test.ts`, mudar `videoReport(reason, fractionLost, sample)` para `videoReport(reason, fractionLost, sample, bytesSent?)`, incluindo `bytesSent` no entry `out` somente quando o parâmetro é fornecido (todos os chamadores antigos continuam iguais). Acrescentar `import type { MirrorState } from "../src/renderer/mirror.ts";` (type-only, removido em runtime) e os testes:

```ts
test("stats: expõe métricas ao onChange e zera no stop", async (t) => {
  installBrowserMocks();
  const video = fakeTrack("video");
  const stream = fakeStream(video, null);
  let sender: FakeSender | null = null;
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class { constructor() { const pc = fakePC(); sender = pc.addTrack(video); return pc; } },
    writable: true, configurable: true,
  });
  const { createMirror } = await importMirror();
  const mirror = createMirror();
  const seen: Array<{ fps: number | null; bitrateBps: number | null }> = [];
  let lastState: MirrorState | null = null;
  mirror.onChange((s) => {
    lastState = s;
    if (s.metrics !== null) seen.push(s.metrics);
  });

  const started = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(started.ok, true);
  assert.equal(seen.length, 0, "sem amostra não deve haver métrica");

  sender!.setStats(videoReport("none", null, 1, 1_000));
  await fireStatsTicks(1);
  assert.equal(seen.at(-1)?.fps, null, "primeira amostra não tem delta");

  sender!.setStats(videoReport("none", null, 2, 4_000));
  await fireStatsTicks(1);
  assert.ok((seen.at(-1)?.fps ?? 0) > 0);
  assert.ok((seen.at(-1)?.bitrateBps ?? 0) > 0);

  mirror.stop();
  assert.equal(lastState?.metrics, null, "stop deve limpar o snapshot");
  assert.equal(lastState?.quality, "1080p");

  t.after(() => { resetMocks(); Object.defineProperty(globalThis, "RTCPeerConnection", { value: RealRTCPC, writable: true, configurable: true }); });
});

test("onChange: unsubscribe interrompe as emissões", async (t) => {
  installBrowserMocks();
  const { createMirror } = await importMirror();
  const mirror = createMirror();
  let emissions = 0;
  const off = mirror.onChange(() => { emissions += 1; });
  const before = emissions;
  off();
  mirror.stop();
  assert.equal(emissions, before, "nenhuma emissão depois do unsubscribe");
  t.after(() => resetMocks());
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `node --test "tests/mirror.test.ts"`
Expected: FAIL — `metrics`/`quality` ausentes em `MirrorState` e `off()` não existe.

- [ ] **Step 3: Implementar a integração em `mirror.ts`**

- `MirrorState` ganha `metrics` e `quality`; o estado inicial usa `metrics: null, quality: "1080p"` (atualizar também o literal inicial em `App.tsx:51-56` é da Task 4, mas o tipo precisa estar certo aqui).
- Substituir `previousFramesEncoded`/`previousTimestamp` por `sendCounters: SendCounters | null`. No timer, chamar `readSendMetrics(sendCounters, { framesEncoded, bytesSent, timestamp, qualityLimitationReason })` uma vez; guardar `sendCounters = counters`, `emit({ metrics })`, e usar `metrics.fps` (quando `!== null`) como entrada de `evaluateLowFpsWarning`. Manter `lastEncoderStats` e `nextAdaptive` intactos.
- `release()` acrescenta `sendCounters = null`, `metrics: null` e `quality: "1080p"` no estado emitido; `statsTimer` já é limpado ali.
- Atualizar o literal inicial de `useState<MirrorState>` em `App.tsx:51-56` com `quality: "1080p", metrics: null` — apenas esses dois campos, sem tocar no restante do componente nesta tarefa.
- Atualizar `quality` junto com `lastAppliedQuality` em `start()`, no sucesso de `setQuality()` e no revert por falha de `setParameters`.
- `onChange` cadastra o listener no `Set` e devolve `() => listeners.delete(listener)`.

- [ ] **Step 4: Rodar testes, tipos e gate**

Run: `node --test "tests/mirror.test.ts"`
Expected: PASS.
Run: `npx tsc -p tsconfig.json && npm run verify`
Expected: limpo. O literal de `App.tsx` já foi atualizado nesta tarefa, então o tipo não fica quebrado entre commits.

- [ ] **Step 5: Commitar**

Run: `git add src/renderer/mirror.ts tests/mirror.test.ts`
Run: `git commit --no-gpg-sign -m "feat(fase2): publicar metricas do host e unsubscribe do onChange"`

### Task 4: Componente `LiveStatus` no status-area

**Files:**
- Create: `src/renderer/LiveStatus.tsx`
- Modify: `src/renderer/App.tsx:1-56`, `:86-101`, `:276-301`
- Modify: `src/renderer/host.css` (após `.status`, antes do bloco do preview)

**Interfaces:**
- Consumes: `MirrorState` (`status`, `quality`, `audio`, `metrics`), `SendMetrics` de `capture.ts`, `MirrorStatus` de `mirror.ts`, `Quality` de `ipc.ts`.
- Produces: `LiveStatus(props: { status: MirrorStatus; quality: Quality; audio: boolean; metrics: SendMetrics | null }): JSX.Element`, sem efeitos colaterais.

- [ ] **Step 1: Escrever o componente**

`<dl className="live-status" aria-label="Live transmission status">` com cinco pares `dt`/`dd`: `Send`, `Bitrate`, `Quality`, `Audio`, `Encoder`. Formatação: `—` quando `metrics === null`, `status === "idle"` ou `status === "error"`; `fps` com `toFixed(0)` quando finito e `> 0`; `bitrateBps / 1_000_000` com `toFixed(1)` quando finito e `> 0`; `quality` (`native`/`1080p`/`720p`); `On`/`Off`; `limitReason` mapeado para `Stable` (`none`), `Network` (`bandwidth`), `CPU-limited` (`cpu`), senão `—`. Sem `role="status"` no `<dl>` e sem inline style.

- [ ] **Step 2: Ligar ao `App` e limpar o listener**

O literal inicial de `useState<MirrorState>` já foi atualizado na Task 3; aqui apenas ligar o componente. No effect de `App.tsx:86-101`, guardar `const offMirror = mirror.onChange(setState)` e devolver cleanup que chama `offMirror()`; deixar `onState`/`onSignal` como estão. Renderizar `<LiveStatus ...>` dentro de `.status-area`, logo após o `<p className="status" role="status">`.

- [ ] **Step 3: Estilizar sem quebrar o layout**

Acrescentar em `host.css`: `.live-status { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 4px 10px; margin: 2px 0 0; padding-top: 7px; border-top: 1px solid var(--farol-color-hairline); }`, `dt` em 10px, `text-transform: uppercase`, cor `--farol-color-ink-muted-48`; `dd { margin: 0; font-size: 12px; font-variant-numeric: tabular-nums; }`. Nenhuma nova media query, nenhuma fonte externa.

- [ ] **Step 4: Verificar e revisar**

Run: `npx tsc -p tsconfig.json && npm run verify`
Expected: limpo; cobertura ≥ 99,71% (se subir, atualizar ratchet em `package.json`, `CONSTRAINTS.md`, `tasks/todo.md` e no design doc antes do commit).
Run: `git diff --check`
Expected: sem whitespace errors.
Revisar o diff com `@code-reviewer` e `@react-reviewer`; corrigir achados críticos/importantes antes do commit.

- [ ] **Step 5: Commitar**

Run: `git add src/renderer/LiveStatus.tsx src/renderer/App.tsx src/renderer/host.css package.json CONSTRAINTS.md tasks/todo.md docs/superpowers/specs/2026-11-25-painel-status-host-design.md` (incluir os dois últimos apenas se o ratchet tiver mudado)
Run: `git commit --no-gpg-sign -m "feat(fase2): painel de status ao vivo no host"`

## Self-review

- **Spec coverage:** intenção (§1) → Tasks 3/4; achados (§2) → Task 3; contrato puro (§3) → Task 2; integração (§4) → Task 3; UI (§5) → Task 4; fora de escopo (§6) → Global Constraints; testes (§7) → Tasks 2/3/4; docs (§8) → Task 1; verificação (§9) → Task 4.
- **Tipos:** `SendCounters`, `SendSample`, `SendMetrics`, `readSendMetrics`, `MirrorState.metrics`, `MirrorState.quality`, `LiveStatus` — mesmos nomes em todas as tarefas. `getEncoderStats()` permanece intocado.
- **Riscos sem teste automatizado:** formatação/leitura de tela coberta pelo Review Focus e revisão de React; o projeto não tem infra de teste de componente e isso está registrado como fora de escopo no design doc.

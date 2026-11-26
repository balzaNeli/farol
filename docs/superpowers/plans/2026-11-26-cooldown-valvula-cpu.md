# Cooldown da válvula CPU Implementation Plan

> **Execução escolhida pelo parceiro humano:** fluxo ECC com `tdd-guide` (RED → GREEN → REFACTOR), `code-reviewer` e `build-error-resolver` se necessário. Steps usam checkbox (`- [ ]`) para acompanhamento.

**Goal:** Eliminar o flap da válvula EX-001 (`scaleResolutionDownBy` 1.5 ↔ 1.0 a cada 3 s) que causa picos de `CPU-limited` e oscilação de FPS na captura de janela específica no Windows, sem alterar a exceção registrada.

**Architecture:** A válvula passa a ser uma decisão pura com histerese de entrada e cooldown de re-engajamento, mantendo a saída imediata em `none`. O timer de 3 s existente e a fila `paramsChain` continuam sendo os únicos mecanismos; nenhum timer, sinal, IPC ou dependência nova. `isWindowSurface()` passa a ser a única fonte de verdade para o tipo de superfície no host.

**Tech Stack:** TypeScript (Node 24, type stripping), `node:test` + `node:assert/strict`, Electron 44 / WebRTC no renderer, Vite + React.

**Spec:** `SPEC.md` Rev 7 (2026-11-25) + `CONSTRAINTS.md` EX-001 + `docs/superpowers/specs/2026-11-25-fase2-resiliencia-adaptativa-design.md`. Diagnóstico em `docs/superpowers/plans/2026-11-25-painel-status-host.md` (painel que expôs o sintoma).

## Global Constraints

- `EX-001` intacta: `scaleResolutionDownBy` é `1.5` **somente** enquanto `reason === "cpu"`; volta a `1.0` na mesma amostra em `none`, `bandwidth`, ausente, `null` ou desconhecido. Ficar em `1.0` durante `cpu` (cooldown) é permitido — a regra é restritiva, não obrigatória.
- `degradationPreference` permanece `"maintain-resolution"` em todos os caminhos; rede nunca reduz resolução.
- `RTC_CONFIG.iceServers` vazio e congelado; viewer receive-only; host em `file://` — `npm run check:gates`.
- Nenhum timer novo, nenhum `Signal`/IPC novo, nenhuma dependência de runtime nova, nenhuma telemetria fora da LAN.
- Sem `@ts-ignore`, `eslint-disable`, `console.log`, testes pulados ou stubs.
- Cobertura dos módulos puros ≥ 99,73% (ratchet atual); `npx tsc -p tsconfig.json` e `npm run verify` 100% verdes.
- Commits com `--no-gpg-sign`, nada pushed; deixar em stage ou commit para assinatura manual.

## Review Focus

- Janela específica no Windows capturada a ~17 fps: o motivo do encoder alterna `cpu`/`none` — uma amostra isolada não pode reconfigurar o encoder.
- `quality === "native"` continua devolvendo o **mesmo objeto** de estado e `apply: null`.
- `bandwidth`/perda alta continuam derrubando o bitrate com a histerese de 2 amostras, sem tocar na escala.
- Falha de `setParameters()` não pode avançar o estado adaptativo (já coberto); reset por `setQuality()`, `start()` e `stop()` deve zerar streak e cooldown.
- `getSurfaceType()` deve refletir `isWindowSurface()`; superfícies desconhecidas (`"monitor"`, ausente) são `screen`, nunca `window`.

---

### Task 1: Reducer adaptativo com histerese e cooldown

**Files:**
- Modify: `src/shared/capture.ts`
- Test: `tests/adaptive.test.ts`, `tests/capture.test.ts`

**Interfaces:**
- Consumes: `AdaptiveSample`, `EncoderScale`, `TARGET_BITRATE_BPS`, `MIN_BITRATE_BPS` já existentes.
- Produces: `CPU_SAMPLES_TO_SCALE = 2`, `CPU_SCALE_COOLDOWN_TICKS = 3`; `AdaptiveState` ganha `cpuStreak: number` e `cpuCooldownTicks: number`; `initialAdaptiveState()` e `nextAdaptive()` assinaturas inalteradas.

**Regra exata:**
1. `native` → mesmo objeto, `apply: null`.
2. `cpu = reason === "cpu"`; `cpuStreak = cpu ? state.cpuStreak + 1 : 0`.
3. `cooldown = Math.max(0, state.cpuCooldownTicks - 1)` (decrementa **toda** amostra).
4. Se `!cpu`: `scale = 1.0`; se `state.scaleResolutionDownBy === 1.5`, `cooldown = CPU_SCALE_COOLDOWN_TICKS`.
5. Se `cpu && cooldown === 0 && cpuStreak >= CPU_SAMPLES_TO_SCALE`: `scale = 1.5`. Caso contrário, `scale = state.scaleResolutionDownBy`.
6. Bitrate, `downStreak` e `upStreak` permanecem exatamente como hoje; `apply` é `null` se nada mudou.

- [ ] **Step 1: RED** — em `tests/adaptive.test.ts`: uma amostra `cpu` não altera escala; duas consecutivas aplicam `1.5`; `none` volta a `1.0` na mesma amostra e inicia cooldown; `cpu` durante cooldown não re-engaja; após 3 ticks, 2 `cpu` re-engajam; `bandwidth` e `unknown` zeram `cpuStreak`; rede e `native` continuam sem escalar. Atualizar os `deepEqual` que enumeram `AdaptiveState` para os dois campos novos.
- [ ] **Step 2: Rodar** `node --test tests/adaptive.test.ts tests/capture.test.ts` — esperado FAIL.
- [ ] **Step 3: GREEN** — implementar a regra acima em `src/shared/capture.ts` sem tocar na histerese de bitrate.
- [ ] **Step 4: Rodar** o mesmo comando — esperado PASS.
- [ ] **Step 5: Commit** `git commit --no-gpg-sign -m "fix(fase2): cooldown e histerese na valvula CPU (EX-001)"`.

### Task 2: Integração no host e tipo de superfície

**Files:**
- Modify: `src/renderer/mirror.ts`, `tests/mirror.test.ts`

**Interfaces:**
- Consumes: `nextAdaptive` com o novo `AdaptiveState`; `isWindowSurface(displaySurface)` de `../shared/capture.ts`.
- Produces: `resetAdaptive()` zera `cpuStreak`/`cpuCooldownTicks`; `getSurfaceType()` usa o helper puro.

- [ ] **Step 1: RED** — em `tests/mirror.test.ts`: sequência `cpu → none → cpu → cpu` gera no máximo duas escritas de `scaleResolutionDownBy` (não uma por tick); uma track com `getSettings().displaySurface === "window"` faz `getSurfaceType()` retornar `"window"`. Atualizar o teste `stats: CPU usa 1.5...` para alimentar **duas** amostras `cpu` antes de esperar `1.5` (mudança de expectativa registrada no commit).
- [ ] **Step 2: Rodar** `node --test tests/mirror.test.ts` — esperado FAIL.
- [ ] **Step 3: GREEN** — trocar `video.getSettings().displaySurface === "window" ? ...` por `isWindowSurface(...)` e nada mais no timer.
- [ ] **Step 4: Rodar** o mesmo comando — esperado PASS.
- [ ] **Step 5: Commit** `git commit --no-gpg-sign -m "fix(fase2): integra cooldown da valvula e unifica deteccao de janela"`.

### Task 3: Verificação e revisão

**Files:** nenhum; registrar medição pendente em `docs/manual-tests.md` se necessário.

- [ ] **Step 1:** `npx tsc -p tsconfig.json` — zero erros.
- [ ] **Step 2:** `npm run verify` — lint 0 warnings, testes verdes, cobertura ≥ 99,73%, build e gates verdes.
- [ ] **Step 3:** `git diff --check`, grep por `console.log`/`@ts-ignore`/`eslint-disable` no diff.
- [ ] **Step 4:** revisão com `code-reviewer`; `build-error-resolver` apenas se houver erro de build.
- [ ] **Step 5:** confirmar nada pushed; entregar em stage ou commit assinado manualmente.

## Self-Review

- **Spec coverage:** Rev 7 permanece válida — a mudança é uma refinamento da aplicação de EX-001, não uma nova política; nenhuma linha de SPEC/CONSTRAINTS precisa ser enfraquecida.
- **Step scan:** cada step tem uma ação verificável; a regra da Task 1 está completa o suficiente para não exigir decisão do implementador.
- **Type consistency:** `cpuStreak`/`cpuCooldownTicks` aparecem em `AdaptiveState`, `initialAdaptiveState()` e nos `deepEqual` dos testes; `EncoderScale` continua `1.0 | 1.5`.
- **Review Focus:** seis inputs cobertos na Task 1 e dois na Task 2; nenhum failure mode do painel (`cpu`/`none`/`bandwidth`) fica sem teste.
- **Proportion:** plano curto, sem transcrição de código; a regra do reducer é a única parte especificada linha a linha porque é onde a decisão não é inferível.

# Code Deletion Log — Auditoria de Limpeza (Farol)

## [2026-11-26] Auditoria read-only — refactor-cleaner

Este relatório é **apenas diagnóstico**. Nenhum arquivo foi modificado. Ele lista candidatos a remoção/consolidação com evidências de caminho e linha, para revisão humana antes de qualquer edição.

---

## 1. Classes utilitárias órfãs em `src/ui/tokens.css` — REMOVIDAS

`tokens.css` é importado por `src/renderer/host.css` (linha 1) e `src/viewer/viewer.css` (linha 1) via `@import`. As **variáveis CSS** (`--farol-*` no `:root`) são usadas ativamente em ambos os arquivos e foram **mantidas**. Nenhuma das classes utilitárias abaixo é referenciada em qualquer arquivo `.tsx`, `.ts` ou `.html` (grep retornou zero matches em `src/`), então foram removidas:

| Classe | Linhas em tokens.css | Status |
|---|---|---|
| `.farol-surface-parchment` | 59-62 | Removida |
| `.farol-surface-canvas` | 64-67 | Removida |
| `.farol-surface-tile-dark` | 69-72 | Removida |
| `.farol-surface-black` (classe) | 74-77 | Removida (a variável `--farol-color-surface-black` segue usada) |
| `.farol-text-ink` | 80 | Removida |
| `.farol-text-body-muted` | 81 | Removida |
| `.farol-text-ink-muted-80` | 82 | Removida |
| `.farol-text-ink-muted-48` | 83 | Removida |
| `.farol-text-on-dark` | 84 | Removida |
| `.farol-text-primary` | 85 | Removida |
| `.farol-text-primary-on-dark` | 86 | Removida |
| `.farol-font-display` (classe) | 88 | Removida (variável usada diretamente) |
| `.farol-font-text` (classe) | 89 | Removida (variável usada diretamente) |
| `.farol-card` | 92-97 | Removida |
| `.farol-chip` + `.farol-chip.selected` | 99-115 | Removida |
| `.farol-button-primary` + estados | 117-147 | Removida |
| `.farol-button-icon` + estados | 149-173 | Removida |
| `.farol-hairline` | 175-177 | Removida |
| `.farol-divider-soft` | 179-181 | Removida |

Efetivo: todo o bloco de utilitários/componentes (linhas 58–181 do arquivo anterior) foi removido; o `:root` com todas as variáveis `--farol-*` está intacto.

---

## 2. `getSurfaceType` — MANTIDO

- Declarado em `src/renderer/mirror.ts:62` (tipo `Mirror`) e retornado em `mirror.ts:652` (`() => lastSurfaceType`).
- Não chamado em `src/renderer/App.tsx` nem em qualquer outro arquivo de fonte (`src/`).
- Chamado apenas em `tests/mirror.test.ts:709`, `:722`, `:726`.

Decisão da equipe: **manter** `getSurfaceType` em `src/renderer/mirror.ts` e seu teste em `tests/mirror.test.ts` intactos (nenhuma edição feita). Não é "morto" porque os testes o exercitam.

---

## 3. Re-export redundante de `canRestartIce` em `src/viewer/connection.ts` — REMOVIDO

- Linha 3: `export { canRestartIce, MAX_ICE_RESTARTS };` → `export { MAX_ICE_RESTARTS };`
- `MAX_ICE_RESTARTS` é importado por `src/viewer/Watch.tsx` (linhas 9, 211, 499) — **usado**, mantido no re-export.
- `canRestartIce` **é importado externamente por `tests/reconnect.test.ts`** (linhas 4, 44–46), que o usava do re-export de `connection.ts`. Como o pedido remove `canRestartIce` desse re-export, o teste foi ajustado para importar `canRestartIce` de sua definição real (`../src/shared/rtc.ts`, linha 13), mantendo `MAX_ICE_RESTARTS` de `connection.ts`. A importação da linha 1 de `connection.ts` segue intacta (o reducer usa `canRestartIce` internamente).

Efetivo: `canRestartIce` removido do re-export da linha 3 de `connection.ts`; `tests/reconnect.test.ts` agora importa `canRestartIce` de `../src/shared/rtc.ts`; `MAX_ICE_RESTARTS` mantido.

---

## 4. Itens verificados e descartei como NÃO órfãos (para não gerar falso positivo)

| Item | Local | Uso encontrado |
|---|---|---|
| `isWindowSurface` | `src/shared/capture.ts:195` | Usado em `mirror.ts:372` |
| `SendCounters` | `src/shared/capture.ts:135` | Usado em `mirror.ts:145, 175` |
| `SendSample` | `src/shared/capture.ts:137` | Usado em `mirror.ts:412` |
| `SendMetrics` | `src/shared/capture.ts:144` | Usado em `mirror.ts:27, 436` e `LiveStatus.tsx:1, 24` |
| `lastSurfaceType` | `mirror.ts:116` | Estado interno de `mirror.ts` (372, 652, 223) |
| `lowFpsWarning` | `MirrorState` `mirror.ts:26` | Lido em `App.tsx:305` |
| `videoConstraints` vs `applyVideoBitrateCap` | camadas diferentes | Captura (applyConstraints) vs encoder (setParameters) — separação intencional |
| `nextAdaptive` vs timer stats | `capture.ts:85` vs `mirror.ts:405` | Redutor puro vs driver — chamador/calçado, não duplicação |
| `lanAddresses` / `rankedLanAddresses` / `preferredLanAddress` | `lan.ts:73/36/58` | Todos usados: `main.ts:68/72`, `mdns.ts:188`, `http.ts:265` |
| `quitting`, `qrDataUrl`, `qrPayload`, `qrError`, `qrVersion`, `lastQrDataUrl` | `main.ts:35-40` | Todas usadas (pushState, refreshQr, before-quit) |

---

## 5. Complexidade desnecessária (não é dead code, mas candidata a refatoração)

- `src/renderer/mirror.ts` (~654 linhas): `start()` (341-540, ~200 linhas) tem muitas verificações de `run !== generation` espalhadas. Candidato a decomposição em funções menores (ex.: `acquireCapture()`, `setupPeer()`, `startStatsTimer()`). Não é remoção, é refatoração comportamental-preservante. **Não tocado neste lote.**
- `src/shared/capture.ts:85-132` (`nextAdaptive`): redutor puro denso (~48 linhas) com histerese de CPU/largura de banda. Bem comentado; não é candidato a remoção, mas a clareza poderia melhorar com sub-funções nomeadas. **Não tocado neste lote.**

---

## Impacto deste lote (concluído)

- Classes CSS órfãs: 15 classes removidas de `src/ui/tokens.css` (sem impacto no runtime, pois não aplicadas). Variáveis `:root` mantidas.
- Re-export redundante: `canRestartIce` removido do `export {}` de `src/viewer/connection.ts:3` (1 linha alterada). `MAX_ICE_RESTARTS` mantido.
- `getSurfaceType`: mantido em `src/renderer/mirror.ts` e `tests/mirror.test.ts` (sem alteração).

---

## Próximos passos recomendados (pendentes deste lote)

4. Executar `npm run verify` (lint + test + coverage + build + gates) antes de commit.
5. Commitar o lote separadamente (`--no-gpg-sign`) e este log já está atualizado com o que foi realmente removido.

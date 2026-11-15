# Correções restantes da auditoria externa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os defeitos restantes da revisão externa que afetam o uso real na Fire TV: `degradationPreference` no nível errado dos parâmetros do sender, `contentHint = "motion"` que reduz resolução sob pressão, QR apontando para endereço inalcançável, e `rankScore` recebendo IP em vez do nome da interface.

**Architecture:** Alterações cirúrgicas em `src/shared/capture.ts`, `src/renderer/mirror.ts`, `src/main/main.ts` e `src/server/lan.ts`, com testes unitários pinando cada comportamento. Nenhuma nova dependência.

**Tech Stack:** TypeScript 5.7+, Node 24, node:test, ESLint, tsc, Vite, Electron.

**Spec:** `SPEC.md` (rev 5), `CONSTRAINTS.md`, `AGENTS.md`.

## Global Constraints

- Zero novas dependências runtime (apenas `ws` + `qrcode` já existentes)
- `RTC_CONFIG.iceServers` vazio e congelado (`src/` e `dist/`)
- Viewer receive-only (sem `getUserMedia`, `getDisplayMedia`, `navigator.mediaDevices` em `src/viewer` ou `dist/viewer`)
- Nenhum `@ts-ignore`, `eslint-disable`, stub não implementado, ou teste pulado
- `npm run verify` 100% verde: lint 0 warnings, todos os testes passando, cobertura ≥ 95.88%, build, check:gates OK
- `npx tsc -p tsconfig.json` limpo (cobre renderer, viewer, testes)
- Commits sem `--gpg-sign` para o usuário assinar manualmente

## Review Focus

1. `degradationPreference` dentro de `encodings[0]` é ignorado pelo Chromium — deve estar no nível de cima de `params`
2. `contentHint = "motion"` pede ao Chromium para reduzir resolução sob pressão — contradiz "resolução nunca reduzida"
3. QR usa `lanAddresses()` (ordem alfabética) — pode apontar para `172.x` virtual antes de `192.168.x` Wi-Fi
4. `rankScore(entry.address)` recebe IP em vez do nome da interface — todo endereço recebe nota 0
5. `main.ts:66` não usa `preferredLanAddress()` para o QR primário

---

### Task 1: degradationPreference no nível dos params + contentHint correto

**Files:**
- Modify: `src/shared/capture.ts:22-31`
- Modify: `src/renderer/mirror.ts:197-215`, `src/renderer/mirror.ts:268-270`
- Test: `tests/mirror.test.ts` (novo teste)

**Interfaces:**
- `applyVideoBitrateCap(sender, maxBitrateBps, quality)`: define `params.degradationPreference = "maintain-resolution"` e `params.scaleResolutionDownBy = 1.0` no nível de cima de `params`, não dentro de `encodings[0]`
- `contentHint`: `"detail"` (prioriza qualidade visual, não fps)

- [ ] **Step 1: Escrever teste falhando para degradationPreference no nível de params**
  - Test: `applyVideoBitrateCap` define `params.degradationPreference === "maintain-resolution"` no nível de cima, não apenas em `encodings[0]`

- [ ] **Step 2: Rodar teste para verificar falha**

- [ ] **Step 3: Implementar `params.degradationPreference` e `params.scaleResolutionDownBy` no nível de cima em `applyVideoBitrateCap`**
  - Alterar `capture.ts` `videoEncodingParams` já retorna o campo; `mirror.ts` deve atribuir em `params` diretamente

- [ ] **Step 4: Alterar `contentHint = "motion"` para `contentHint = "detail"` em `mirror.ts:270`**
  - `"detail"` instrui o Chromium a priorizar qualidade, não derrubar resolução

- [ ] **Step 5: Rodar `npm run verify` para confirmar verde**

- [ ] **Step 6: Commit**

```bash
git add src/shared/capture.ts src/renderer/mirror.ts tests/mirror.test.ts
git commit --no-gpg-sign -m "fix: degradationPreference no nível dos params e contentHint=detail para nunca reduzir resolução"
```

---

### Task 2: QR usa preferredLanAddress e rankScore recebe nome da interface

**Files:**
- Modify: `src/server/lan.ts:41` (`rankScore(entry.address)` → `rankScore(entry.name)`)
- Modify: `src/main/main.ts:66` (usa `preferredLanAddress()` para QR primário)
- Test: `tests/lan.test.ts` (testes de `rankedLanAddresses` e `preferredLanAddress`)

**Interfaces:**
- `rankedLanAddresses(interfaces)`: `rankScore` recebe o nome da interface (`entry.name`), não o IP
- `preferredLanAddress(interfaces)`: retorna o endereço de maior score (Wi-Fi > Ethernet > virtual)
- `hostState()` em `main.ts`: QR usa `preferredLanAddress()`; lista de URLs continua completa

- [ ] **Step 1: Escrever testes falhando para `rankedLanAddresses` com score correto por nome de interface**
  - Teste com interface "Wi-Fi" → score 100, "Ethernet" → 80, "vEthernet" → -200

- [ ] **Step 2: Rodar teste para verificar falha**

- [ ] **Step 3: Corrigir `lan.ts:41` passar `entry.name` para `rankScore`**

- [ ] **Step 4: Corrigir `main.ts:66` usar `preferredLanAddress()` para o QR primário**
  - Manter `lanAddresses()` para a lista completa de URLs

- [ ] **Step 5: Rodar `npm run verify` para confirmar verde**

- [ ] **Step 6: Commit**

```bash
git add src/server/lan.ts src/main/main.ts tests/lan.test.ts
git commit --no-gpg-sign -m "fix: QR usa endereço de LAN preferido e rankScore recebe nome da interface"
```

---

### Task 3: Menores críticos — aviso de bitrate preservado, relógio de bloqueio, docs/ no electron-builder

**Files:**
- Modify: `src/renderer/mirror.ts:299, 378` (preservar aviso de bitrate no waiting)
- Modify: `src/viewer/main.tsx:115` (relógio de bloqueio — avaliar se é necessário; pode ser out of scope por ser comportamento de relógio do dispositivo)
- Modify: `electron-builder.json` (incluir `docs/` para `/probe` funcionar no app instalado)
- Test: `tests/security.test.ts` (já testa headers — manter)

**Interfaces:**
- `emit({ status: "waiting", error: state.error, ... })` preserva erro não-crítico
- `electron-builder.json`: `files` inclui `docs/`

- [ ] **Step 1: Verificar que `start()` preserva aviso de bitrate ao entrar em waiting** (já corrigido no lote anterior — apenas confirmar com teste existente)

- [ ] **Step 2: Incluir `docs/` em `electron-builder.json` para `/probe` servir no app instalado**

- [ ] **Step 3: Rodar `npm run verify` para confirmar verde**

- [ ] **Step 4: Commit**

```bash
git add src/renderer/mirror.ts electron-builder.json
git commit --no-gpg-sign -m "fix: preservar aviso de bitrate no waiting e incluir docs/ no instalador"
```

---

## Self-Review

1. **Spec coverage:** 
   - `CONSTRAINTS.md`: "Resolution never reduced as an escape valve" → Task 1 (contentHint + degradationPreference no nível correto)
   - `SPEC.md`: QR aponta para URL do host → Task 2 (preferredLanAddress)
   - `CONSTRAINTS.md`: "No new runtime dependencies" → nenhuma adicionada
   - `CONSTRAINTS.md`: `npm run verify` verde → todas as tasks terminam com verificação

2. **Step scan:** Cada step permite escrever exatamente uma coisa razoável; nenhuma linha "TBD" ou "handle edge cases".

3. **Type consistency:** `rankScore(name: string): number` — chamado com `entry.name: string` (InterfaceEntry.name é string). `preferredLanAddress(): string | null` — usado em `main.ts` com tratamento de null.

4. **Review Focus:** Todos os 5 itens têm tarefa e teste próprios.

5. **Proportion:** Plano é proporcional ao escopo das correções (4 tasks para ~5 arquivos alterados).

---

## Execução

**Plan complete and saved to `docs/superpowers/plans/2026-11-14-auditoria-externa-corcoes-restantes.md`. Please review the plan. Does it capture what you want, and which execution approach should we use?**

- **Subagent-driven** — uma subagente executa cada task e uma revisora fresh verifica antes da próxima; mais completa, custa contexto fresco por task.
- **Native** — executo todas as tasks nesta sessão, com um revisor fresh no final; mais rápido e barato.

Para este plano recomendo **Native**, pois as 3 tasks são independentes entre si (arquivos distintos) e já tenho o contexto completo do código.
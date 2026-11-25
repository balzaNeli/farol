# Farol — descoberta zero-digitação via mDNS (`farol.local`)

Branch: `dev`. Commits **sem** `--gpg-sign` (staged/commits para o usuário assinar com sua chave).

Aprovação: design doc aprovado 2026-11-15 — 5 chamadas vetadas e confirmadas: (a) QR por IP direto,
(b) goodbye TTL 0 no close, (c) AAAA responde vazio, (d) codec puro `src/shared/mdns.ts` dentro do
ratchet de cobertura, (e) mDNS desligado por padrão no `startServer`, ligado explicitamente nos dois
entry points (main.ts e scripts/serve.mjs).

Regras (CONSTRAINTS.md): zero dependências runtime novas (`node:dgram` apenas); `iceServers` vazio;
viewer receive-only; cobertura ≥ 95,88% (ratchet); sem supressões (`@ts-ignore`/`eslint-disable`);
`npm run verify` 100% verde; `npx tsc -p tsconfig.json` limpo.

## Etapa 1 — Spec primeiro (doc-first)
- [x] SPEC.md: seção "LAN name discovery — mDNS `farol.local`" + `HostState.mdnsUrl` + decisão rev 6
- [x] tasks/plan.md: Task 15 na Fase 4
- [x] tasks/todo.md: este arquivo
- [x] Commit docs (71570ed)

## Etapa 2 — Codec puro `src/shared/mdns.ts` (TDD)
- [x] RED `tests/mdns.test.ts` (19 testes unit falhando: módulo inexistente)
- [x] GREEN: codec implementado (`ANSWER_TTL = 120`, TYPE_A/AAAA/TXT); achados do RED corrigidos:
      rdlength+rdata sobrescritos (rdata era `pos+9`, virou `pos+10`), `encodeName` aceitava não-ASCII
      via latin1, resposta multicast precisa de ID 0 (RFC 6762 §18.1)
- [x] package.json: `coverage` inclui `src/shared/mdns.ts` (mdns.ts 100% linhas)
- [x] test + lint + tsc verdes; commit (18f1eba)

## Etapa 3 — Responder `src/server/mdns.ts` (TDD)
- [x] RED: import inexistente (5 testes de socket)
- [x] GREEN: responder (`udp4`+`reuseAddr`, membership por iface física rankeada + default,
      TTL multicast 255, warn único por falha, close com goodbye TTL 0). Diagnóstico empírico:
      wildcard `0.0.0.0:5353` com reuse coexiste com o serviço mDNS do Windows; exclusivo
      específico×específico dá EACCES. Bug do teste: faltava `port: 0` no teste de re-bind
- [x] 24/24 + suite 95/95 verdes; commit (0c39f63)

## Etapa 4 — Integração no `startServer` (TDD)
- [x] RED: 3 testes (opt-in, default off, sobrevivência) falhando por `mdns` inexistente
- [x] GREEN: `ServerOptions.mdns` (hostname/port/address/warn), `RunningServer.mdns`,
      close = goodbye → relay → HTTP. Ruling: teste de porta ocupada precisa do MESMO endereço
      do holder (wildcard×específico-exclusivo coexiste no Windows) — opção `address` exposta
- [x] 98/98 verdes; commit (e72414b)

## Etapa 5 — Wiring (main.ts, serve.mjs, ipc.ts, PairPanel.tsx)
- [x] `HostState.mdnsUrl: string | null` (preload passa o objeto inteiro — sem mudança)
- [x] `main.ts`: `mdns: { hostname: "farol.local" }` + `mdnsUrl` em `hostState()`
- [x] `serve.mjs`: linha "by name" + aviso quando inativa
- [x] `PairPanel.tsx`: nome primeiro com hint, IPs abaixo, QR por IP
- [x] tsc + lint + build verdes; commit (4e3aabf)

## Etapa 6 — Docs e gate final
- [x] README.md + README-EN.md: quick start, Fire TV primeira vez e linha de troubleshooting
      (Firewall UDP 5353, isolamento AP, coexistência com o responder do Windows)
- [x] `npm run verify` 100% verde — exit 0 (98 testes, cobertura 99,65% ≥ 95,88%, build, gates ok)
- [x] `npx tsc -p tsconfig.json` limpo (exit 0)
- [ ] Stage sem `--gpg-sign` para o usuário assinar

## Etapa 7 — Revisão fresh-context e passe de correções
Revisor subagent sobre `6115105..969833e`: **Ready to merge — With fixes** (C1, I1–I3, M1–M9).
Cada correção foi RED → GREEN, com commit próprio:

- [x] Fix 1 (C1 + I3, commit 4aba79e): `scripts/serve.mjs` não passava `mdns` — o SPEC, o README
      e a decisão (e) prometiam o nome no `npm run serve`, e o aviso sempre impresso mentia;
      agora passa `mdns: { hostname: "farol.local" }`. `RunningServer.mdns` virou **getter vivo**
      (uma morte tardia do responder não deixa a UI anunciando nome morto), testado com assert
      pós-close. Bug do teste no caminho: close duplo (corpo + hook) → ERR_SERVER_NOT_RUNNING.
- [x] Fix 2 (I1 + M4 + M5, commit f650e8f): respostas legacy unicast (porta origem ≠ 5353, sem
      QU) agora **sem cache-flush, TTL 10 s e com a questão ecoada** (RFC 6762 §6.7 — resolvers
      legacy não têm coerência de cache; TTL 120 mantinha IP velho por 2 min exatamente no
      cenário que motivou a feature); multicast/QU em formato multicast (id 0, sem questão, §6;
      QU unicast em formato multicast, §5.4); OPCODE ≠ 0 rejeitado no parser (§18.3). Ajustes
      colaterais: os dois testes de socket real atualizados ao formato legacy + teardown
      idempotente (`closeOnce`) — um assert falhando no meio deixava o socket do cliente aberto
      e pendurava o runner.
- [x] Fix 3 (I2 + M1/M2/M3, commit 24c710e): **re-anúncio na troca de IP** (§8.4 MUST) — poll
      injetável de 5 s (`changePollMs`), dois anúncios com 1 s de gap (`announceGapMs`, §8.3),
      `lastAnnounced` tomado no boot; teste novo com **observador real** (socket no grupo
      224.0.0.251:5353 com `setMulticastLoopback(true)` explícito) que também prova o poll parado
      pós-close. Aviso único por falha de bind (handler genérico registrado só pós-bind);
      goodbye pulado quando não há endereço; goodbye/anúncios em formato multicast (sem
      questão); timers com `unref()` e limpos em todo caminho de stop. Teste de porta ocupada:
      holder fechado em `t.after` idempotente (o close no corpo após o assert pendurava o runner).
- [x] Fix 4 (docs, este commit): SPEC rev 6 alinhado (legacy TTL/flush/eco, re-anúncio, getter
      vivo, opções novas), README PT/EN com linha "dois Farol no mesmo LAN" (M9), Task 15
      marcado com nota do check pendente (M6), este ledger.

## Rulings do executor (itens que o revisor deixou "declined to judge")
- **Dois Farol no mesmo LAN** (probing/conflito, §9): adiado — fora de escopo por design; docs
  viraram a linha de troubleshooting acima.
- **Anúncios não solicitados no boot** (§8.3): adiado — responder passivo basta para resolução
  on-demand na navegação; o re-anúncio por MUDANÇA de IP foi implementado no Fix 3.
- **Atraso aleatório de 20–120 ms nas respostas** (§6 SHOULD): dispensado — o §6 dispensa o
  atraso para registro único de hostname; risco de colisão desprezível.
- **Resposta QU multicast quando o registro não foi anunciado recentemente** (§5.4): dispensado
  — irrelevante para um único registro; absorvido no formato multicast do Fix 2.
- **Known-answer suppression (§7.1) / multipacket TC**: fora de escopo (mantido).
- **NSEC negativo para AAAA** (§6.1): mantida a decisão pré-aprovada (c) — resposta vazia.
- **Off-by-one no limite de 255 bytes do nome**: não mudar — inalcançável (só `farol.local` é
  construído; nomes gigantes que chegam já são rejeitados pelas guardas do parser).
- **Checagem de origem on-link para queries unicast** (§5.5): adiado — mesma exposição do HTTP
  (bound 0.0.0.0, responde a quem conectar); endurecimento futuro, não regressão.
- **`RunningServer.hostname`** (recommendation): adiado — `main.ts` e `serve.mjs` fixam
  `farol.local`; o risco de a UI mentir só existe se alguém configurar outro nome.

## Fora de escopo (não fazer)
- Anúncio Bonjour completo (PTR `_http._tcp.local`, browse) — cortado no design
- Resposta a TXT/SRV, known-answer suppression (§7.1), NAT-PMP — não pedidos
- QR por `farol.local` — vetado: QR precisa funcionar mesmo com UDP 5353 bloqueado

## Pendente para o usuário (manual)
- [ ] Verificar na Fire TV que o Silk resolve `farol.local` (Chromium tem resolver mDNS próprio);
      se não resolver, o IP favoritado continua como fallback (não é regressão)
- [ ] Assinar os commits com sua chave GPG (todos foram criados com `--no-gpg-sign` e estão na
      dev; o range completo da Task 15 é `6115105..HEAD`)

---

# Fase 2 das otimizações — resiliência de rede e qualidade adaptativa

Branch: `dev`. Commits com `--no-gpg-sign` para assinatura manual. Aprovação da Abordagem A em
2026-11-25; design em
`docs/superpowers/specs/2026-11-25-fase2-resiliencia-adaptativa-design.md`.

Regras (CONSTRAINTS.md + EX-001): LAN oscilando = 1080p fixo e queda de fps aceita; só o motivo
`"cpu"` no encoder do host autoriza `scaleResolutionDownBy = 1.5`, voltando a `1.0` em `"none"`;
`iceServers` vazio; viewer receive-only; sem novas dependências runtime; cobertura dos módulos
puros ≥ 95,88%; zero warnings no lint; sem `@ts-ignore`/`eslint-disable`.

## Etapa 1 — Spec primeiro (doc-first)
- [x] `docs/superpowers/specs/...-design.md` (Abordagem A, números e eixos independentes)
- [x] `SPEC.md` rev 7 (limite de 2 restarts + bitrate adaptativo)
- [x] `tasks/plan.md` Fase 5 / Tasks 16–17
- [x] `tasks/todo.md` este ledger

## Etapa 2 — Funções puras (TDD)
- [ ] RED: `tests/adaptive.test.ts` + novos casos em `tests/reconnect.test.ts` (@tdd-guide)
- [ ] GREEN: `initialAdaptiveState()` + `nextAdaptive()` em `src/shared/capture.ts`
- [ ] GREEN: `MAX_ICE_RESTARTS`, `canRestartIce()` e evento `checking` em
      `src/viewer/connection.ts`

## Etapa 3 — Wiring no host (TDD)
- [ ] RED: teste de reprodução da válvula EX-001 inerte em `tests/mirror.test.ts`
- [ ] GREEN: `applyVideoBitrateCap()` escreve o `scale` no topo e em `encodings[0]`
- [ ] RED/GREEN: timer de 3 s alimenta `nextAdaptive()` com `outbound-rtp` +
      `remote-inbound-rtp`, via fila serial `paramsChain`
- [ ] RED/GREEN: orçamento de 2 ICE restarts no host

## Etapa 4 — Viewer (TDD indireto + tipos)
- [ ] `Watch.tsx`: `checking`, retry 1/2 com timer de 8 s por tentativa, status `(n/2)`
- [ ] Sem APIs de captura, sem novo `Signal`, sem re-pair automático após `lost`

## Etapa 5 — Gate, revisão e assinatura
- [ ] `npx tsc -p tsconfig.json` limpo
- [ ] `npm run verify` verde (lint, testes, cobertura ≥ 95,88%, build, gates)
- [ ] `@code-reviewer` fresh-context sobre o diff da Fase 2
- [ ] Pendência manual: medir na Fire TV oscilação de LAN (1080p fixo) e 2 restarts em
      `docs/manual-tests.md`
- [ ] Commits com `--no-gpg-sign` deixados para assinatura manual

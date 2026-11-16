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

## Fora de escopo (não fazer)
- Anúncio Bonjour completo (PTR `_http._tcp.local`, browse) — cortado no design
- Resposta a TXT/SRV, known-answer suppression (§7.1), NAT-PMP — não pedidos
- QR por `farol.local` — vetado: QR precisa funcionar mesmo com UDP 5353 bloqueado

## Pendente para o usuário (manual)
- [ ] Verificar na Fire TV que o Silk resolve `farol.local` (Chromium tem resolver mDNS próprio);
      se não resolver, o IP favoritado continua como fallback (não é regressão)
- [ ] Assinar os commits com sua chave GPG (foram criados com `--no-gpg-sign` e estão staged/na dev)

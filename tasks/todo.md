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
- [ ] Commit docs

## Etapa 2 — Codec puro `src/shared/mdns.ts` (TDD)
- [ ] RED `tests/mdns.test.ts`: `parseDnsMessage` — query A real para `farol.local` (QTYPE 1,
      QCLASS 1), pacote < 12 bytes → null, truncado no meio do QNAME → null, ponteiro de
      compressão com guarda de saltos, mensagem com QR=1 (`isResponse: true`), QU bit detectado;
      `buildQuery` ida-e-volta com `parseDnsMessage`; `buildResponse` — A record com TTL 120,
      cache-flush (`0x8001`), endereço inválido → null, AAAA vazio (ANCOUNT 0);
      `mdnsReply` — legacy (porta origem ≠ 5353) → unicast com ID ecoado, multicast → ID 0,
      QU → unicast mesmo com porta 5353, nome case-insensitive (`Farol.LOCAL` casa),
      hostname diferente → null, tipo desconhecido (ex. TXT) → null, `address: null` → null
- [ ] GREEN: implementar o codec (`ANSWER_TTL = 120`, TYPE_A = 1, TYPE_AAAA = 28)
- [ ] package.json: `coverage` inclui `--test-coverage-include=src/shared/mdns.ts`
- [ ] `npm test` + `npm run lint` + `npx tsc -p tsconfig.json` verdes; commit

## Etapa 3 — Responder `src/server/mdns.ts` (TDD)
- [ ] RED `tests/mdns.test.ts` (socket real): responder em `127.0.0.1:0` com `multicast: false`;
      cliente dgram envia `buildQuery`, recebe resposta e decodifica — A == endereço injetado;
      duas queries com endereço injetado trocado → duas respostas diferentes (IP novo por consulta);
      close libera a porta (re-bind no mesmo porto OK); responder em porta mantida por socket
      exclusivo → `active: false` + `warn` chamado + `close()` resolve sem pendurar; close com
      goodbye (multicast ativo, porta efêmera? não — goodbye só com multicast) não pendura o teste
- [ ] GREEN: implementar responder (`udp4` + `reuseAddr`, bind 0.0.0.0:5353,
      `addMembership("224.0.0.251")` por interface física ranqueada + default,
      `setMulticastTTL(255)`, erro → warn único e `active: false`, close envia goodbye TTL 0 e
      fecha o socket, nunca lança)
- [ ] `npm test` + `npm run lint` + `npx tsc -p tsconfig.json` verdes; commit

## Etapa 4 — Integração no `startServer` (TDD)
- [ ] RED `tests/http.test.ts`: `mdns: { port: 0 }` → `server.mdns === true` e `close()` completa;
      `mdns: { port: <ocupada exclusivamente> }` → `server.mdns === false` e o HTTP segue servindo
      (`/api/info` 200); sem opção → `server.mdns === false`
- [ ] GREEN: `ServerOptions.mdns?: { hostname?: string; port?: number; warn?: (msg: string) => void } | false`;
      `RunningServer.mdns: boolean`; `close()` fecha o responder (goodbye → relay → HTTP)
- [ ] `npm test` + `npm run lint` + `npx tsc -p tsconfig.json` verdes; commit

## Etapa 5 — Wiring (main.ts, serve.mjs, ipc.ts, PairPanel.tsx)
- [ ] `src/shared/ipc.ts`: `HostState.mdnsUrl: string | null`
- [ ] `src/main/main.ts`: `startServer({ pairing, mdns: { hostname: "farol.local", warn: console.warn } })`;
      `hostState()` monta `mdnsUrl = server?.mdns ? \`http://farol.local:${port}/\` : null`
- [ ] `scripts/serve.mjs`: linha `by name : http://farol.local:<port>` + aviso se `!server.mdns`
- [ ] `src/renderer/PairPanel.tsx`: primeira linha copiável `http://farol.local:PORT/` com hint
      "segue o IP do PC — não precisa digitar IP", IPs embaixo como fallback
- [ ] `npx tsc -p tsconfig.json` limpo (renderer só é checado aqui) + `npm run build` OK; commit

## Etapa 6 — Docs e gate final
- [ ] README.md + README-EN.md: quick start menciona `http://farol.local:4680/` (nome primeiro,
      IP como fallback) + troubleshooting: Firewall do Windows pode pedir UDP 5353 na 1ª execução,
      isolamento AP bloqueia multicast, Silk resolve `.local` (Chromium tem resolver mDNS próprio)
- [ ] `npm run verify` 100% verde (lint 0 warnings, cobertura ≥ 95,88%, build, check:gates)
- [ ] `npx tsc -p tsconfig.json` limpo
- [ ] Stage sem `--gpg-sign` para o usuário assinar

## Fora de escopo (não fazer)
- Anúncio Bonjour completo (PTR `_http._tcp.local`, browse) — cortado no design
- Resposta a TXT/SRV, known-answer suppression (§7.1), NAT-PMP — não pedidos
- QR por `farol.local` — vetado: QR precisa funcionar mesmo com UDP 5353 bloqueado

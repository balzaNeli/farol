# Farol — refactor visual da UI (host + viewer)

STATUS: CONCLUÍDO (todas as fases verificadas com `npm run verify` verde).

Fonte: DESIGN.md (tokens Apple) + CONSTRAINTS.md + SPEC.md + AGENTS.md.
Design aprovado pelo usuário ("segue", arquivo de tokens compartilhado).
Commits: sem assinatura GPG (usuário assina).

## Regras de ouro (respeitadas)
- Não tocada lógica: WebRTC, IPC, pareamento, protocolos, `mirror.ts`, `Watch.tsx` (lógica), `connection.ts`, `pin.ts`, `App.tsx` (lógica), seletores/labels exigidos por testes.
- Sem Google Fonts / rede; fonte apenas `system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', sans-serif`.
- CSP rígida do viewer: CSS estático via arquivos importados pelo Vite (sem `<style>`/`<script>` inline).
- `check:gates`: `iceServers` vazio e congelado; viewer sem `getUserMedia`/`getDisplayMedia`/`navigator.mediaDevices`.
- `npm run verify` verde ao final de cada fase.

## Fase A — Tokens CSS compartilhados (src/ui/tokens.css) ✅
- [x] A.1 Criar `src/ui/tokens.css` com variáveis CSS do DESIGN.md (cores, tipografia, spacing, rounded). Fonte apenas do sistema.
- [x] A.2 `host.css` importa `./../ui/tokens.css` (tema âmbar antigo removido).
- [x] A.3 `viewer.css` importa `./../ui/tokens.css` (tema âmbar antigo removido).
- [x] A.4 `vite.config.ts` (duas entradas, base "./") e `scripts/check-gates.mjs` resolvem o import relativo sem problemas.
- [x] A.5 `npm run verify` verde.

## Fase B — Host (src/renderer/) — estética de galeria ✅
- [x] B.1 `host.css`: fundo parchment `#f5f5f7`, utility cards `#ffffff` radius 18px + hairline `#e0e0e0`, bloco escuro `#272729` (pareamento/QR), pílulas `#0066cc` com `scale(0.95)` ativo, chips de configuração.
- [x] B.2 Markup de `App.tsx` e `PairPanel.tsx` mantido (mesma lógica, mesma ARIA/roles, mesma estrutura de classes).
- [x] B.3 `npm run verify` verde.

## Fase C — Visualizador (src/viewer/) — TV-first, preto ✅
- [x] C.1 `viewer.css`: player sobre `#000000`, PIN pad só de botões (sem `<input>`), alvos ≥ 44×44px, foco D-pad `#0071e3` / `#2997ff`, controles flutuantes discretos, `?debug=1` intacto.
- [x] C.2 Markup de `PinPad.tsx`, `Watch.tsx`, `main.tsx` mantido (mesma lógica, teclas `m`/`f`/Enter, reducer de reconnexão intacto).
- [x] C.3 `npm run verify` verde.

## Conclusão ✅
- [x] D.1 `npm run verify` final verde (tudo junto).
- [ ] D.2 Commit sem assinatura GPG (usuário assina). Commit deve nomear a tarefa do spec (ex. `refactor(ui): aplica tokens DESIGN.md ao host e viewer`).

# Farol — destravar 30 fps na captura de janela (Windows)

Branch: `dev` (a partir de `master`). Commit final sem `--gpg-sign` para o usuário assinar.

Aprovação: design doc (Front 1 + Front 3; Front 2 investigado, não aplicado) aprovado.
Detalhes incorporados no Front 3:
- Aviso só se FPS entre 8 e 23 (ativo, descarta janela estática/minimizada < 8).
- Limpa se FPS >= 25 por 3 amostras seguidas, ou qualidade -> 720p, ou stop().

Regras (CONSTRAINTS.md): sem novas dependências runtime; iceServers vazio; viewer receive-only; npm run verify 100% verde; tsc -p tsconfig.json limpo.

## Concluído
- [x] Front 1: `frameRate: { ideal: 30, max: 30 }` em src/shared/capture.ts + testes atualizados em tests/capture.test.ts
- [x] Front 3: MirrorState.lowFpsWarning, statsTimer calcula FPS, aviso dinâmico em mirror.ts; App.tsx renderiza state.lowFpsWarning e removeu aviso estático de janela
- [x] Front 2: documentado como investigado, nenhum switch Electron 44 válido encontrado, não aplicado
- [x] npm run verify verde (lint 0 warnings, 59 testes, cobertura 95.88%, build, check:gates ok)
- [x] npx tsc -p tsconfig.json limpo (cobre renderer + testes)

## Pendente
- [ ] Commit sem --gpg-sign (staged) para o usuário assinar com sua chave GPG

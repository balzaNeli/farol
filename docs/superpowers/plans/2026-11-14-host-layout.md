# Host Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganizar a janela Host em um painel compacto com pareamento e controles em dois cards, sem mudar a lógica de captura ou sinalização.

**Architecture:** Reaproveitar `PairPanel` para os dados de pareamento e reorganizar o JSX de `App.tsx` em cabeçalho e grade. Reescrever `host.css` para a hierarquia visual, incluindo adaptações responsivas e preview condicionado ao estado existente.

**Tech Stack:** React, TypeScript, CSS, Electron renderer existente.

**Spec:** `docs/superpowers/specs/2026-11-14-host-layout-design.md`

## Global Constraints

- Não alterar `mirror.ts`, IPC, captura, WebRTC ou viewer.
- Sem dependências runtime ou recursos externos; manter CSP e gates do projeto.
- Seguir `CONSTRAINTS.md`, `DESIGN.md` e `SPEC.md`; não enfraquecer limites.
- Preservar todos os estados, refs, handlers e comportamento de `App.tsx` existentes.

## Review Focus

- Erros e avisos continuam visíveis no painel em estados de falha, início e reconexão.
- Toggle e qualidade permanecem utilizáveis durante/fora da transmissão com as mesmas restrições atuais.
- Falta de fontes, ausência de áudio e URL indisponível mantêm feedback legível.
- Layout responsivo não esconde controles nem causa overflow horizontal.
- Cópia da URL fornece feedback de sucesso e falha sem afetar pareamento.

## File Map

- `src/renderer/App.tsx`: JSX da janela, label de qualidade, preview/placeholder e ação de copiar.
- `src/renderer/PairPanel.tsx`: URL e controle de cópia, preservando cálculo de QR/PIN/expiração.
- `src/renderer/host.css`: grade, cards, controles, foco, avisos, preview e breakpoints.

## Tasks

### Task 1: Reestruturar a interface Host

- [x] Alterar `App.tsx` para cabeçalho e grade de dois cards, reorganizando controles sem alterar handlers/estados existentes.
- [x] Em `PairPanel.tsx`, acrescentar botão compacto para copiar endereço e feedback correspondente.
- [x] Exibir placeholder visual de preview quando inativo e vídeo existente quando ativo.
- [x] Refazer `host.css` com painel central de até 960px, grade desktop assimétrica, segmented control, switch, foco acessível e layout empilhado em viewport estreita.
- [x] Revisar diff para confirmar que nenhuma lógica fora do escopo mudou.

### Task 2: Verificar e preparar entrega

- [x] Rodar `npm run verify` e `npx tsc -p tsconfig.json`.
- [x] Corrigir regressões sem relaxar constraints e repetir as verificações relevantes.
- [x] Conferir `git diff` e `git status`; stage somente os arquivos desta tarefa, preservando mudanças preexistentes.

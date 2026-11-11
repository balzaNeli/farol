# Design doc — Redesign da UI para "Farol"

**Data:** 2026-11-11  
**Autor:** agente de implementação (OpenCode)  
**Status:** pendente de aprovação do parceiro humano

## 1. Intent e por que

O projeto (`farol`) é um host Electron que captura a tela + áudio do sistema e envia por WebRTC para um browser viewer na mesma rede LAN (principalmente Amazon Fire TV com Silk; telefones/tablets são secundários). Nada sai da rede local.

A interface atual funciona, mas é visualmente genérica: cinzas, tons de verde apagados, sem identidade de marca e pouca interatividade (hover/estado de pressionado discretos). O usuário pediu para:

- refazer a interface, deixando mais bonita e interativa;
- renomear todo texto visível de "screenmirror" para "Farol".

A abordagem escolhida é a **B — "Farol — farol/lâmpada"**: marca própria, minimalista, fundo escuro profundo, destaque âmbar usado com parcimônia (botão primário, ponto "ao vivo", conta do PIN), tipografia sem serifa limpa.

## 2. Goals

- Todos os textos visíveis que hoje dizem "screenmirror" passam a dizer "Farol" (títulos das páginas, `<h1>` do viewer, dialogs de erro do Electron, rótulos e hints da UI).
- Identidade visual coerente em host e viewer: paleta escura com destaque âmbar, espaçamento consistente, tipografia sem serifa.
- Interatividade clara: estados de hover, pressionado (active), foco visível, transições suaves entre estados de pareamento e reprodução.
- Manter todas as restrições não negociáveis do projeto (veja §4).
- Não adicionar dependências de runtime novas (sem ícones, sem fontes externas, sem bibliotecas de UI).

## 3. Non-goals

- Não mudar o protocolo de sinalização, o WebRTC, o servidor HTTP, o emparelhamento ou a captura de mídia.
- Não adicionar modo claro (o produto é usado em sala de estar/escura; dark mode é o correto).
- Não adicionar anotações, desenhos sobre o vídeo ou controles de câmera/microfone no viewer (o viewer é receive-only).
- Não alterar o comportamento de `check:gates` (sem STUN/TURN, sem APIs de captura no viewer, sem `iceServers` preenchido).

## 4. Anti-goals

- Não usar emoji como ícone estrutural.
- Não usar `<input>` para o PIN no viewer (Silk dispara teclado na tela e quebra o fluxo remoto).
- Não usar `<script>` ou `<style>` inline nas páginas servidas (CSP strict).
- Não adicionar dependências de npm além das já existentes.

## 5. Constraints (não negociáveis)

| Restrição | Fonte |
|-----------|-------|
| Viewer é receive-only; sem `getUserMedia`/`getDisplayMedia`/`navigator.mediaDevices` | AGENTS.md + `check:gates` |
| PIN pad é botões, nunca `<input>` | AGENTS.md (Silk on-screen keyboard) |
| `RTC_CONFIG.iceServers` vazio e congelado | AGENTS.md + `check:gates` |
| CSP strict em toda resposta servida | AGENTS.md (`src/server/http.ts`) |
| Sinalização relata `Signal` frames verbatim, nunca parseia SDP | AGENTS.md |
| Host page fica em `file://`; nunca servida pelo HTTP | AGENTS.md |
| Tipo de fonte, ícones e imagens: nada novo além do que já existe | restrição de dependências |

## 6. Abordagens consideradas

| Abordagem | O que propunha | Trade-offs | Por que não foi escolhida |
|-----------|----------------|------------|---------------------------|
| A — "Farol — sinal" | Verde/âmbar/vermelho como estados, monospace para PIN/endereços, alto contraste | Muito funcional, pouca marca; verde lembra o visual atual | Escolhida parcialmente (cores de estado), mas não como identidade principal |
| B — "Farol — farol/lâmpada" **(ESCOLHIDA)** | Fundo escuro profundo, destaque âmbar parcimonioso, sem serifa limpa | Requer cuidado com contraste na Silk; sem dependências novas | Atende ao pedido de "mais bonito" com identidade própria |
| C — "Farol — imersivo vidro escuro" | Vidro fosco, gradientes, ciano/azul, transições suaves | Mais bonito, mas risco de desempenho na Fire TV e contraste | Demais decoração para um stick de TV; deixado para uma fase futura |

## 7. Como será feito (partes do how já decididas)

### 7.1 Renomeação "screenmirror" → "Farol"

Arquivos com texto visível a alterar:

| Arquivo | Texto a mudar |
|---------|---------------|
| `src/renderer/index.html` | `<title>screenmirror - host</title>` → `<title>Farol - host</title>` |
| `src/viewer/index.html` | `<title>screenmirror</title>` → `<title>Farol</title>` |
| `src/viewer/main.tsx` | `<h1>{info?.name ?? "screenmirror"}</h1>` → `<h1>{info?.name ?? "Farol"}</h1>` |
| `src/renderer/App.tsx` | `<h1>screenmirror</h1>` → `<h1>Farol</h1>` |
| `src/main/main.ts` | `dialog.showErrorBox("screenmirror", ...)` → `dialog.showErrorBox("Farol", ...)` (3 ocorrências) |
| `src/renderer/mirror.ts` | mensagem de negação de captura menciona "screenmirror" → "Farol" |
| `docs/silk-probe.html`, `docs/silk-probe.js` | título/h1/console mencionam "screenmirror probe" → "Farol probe" (docs, não afetam o build/tests) |
| `AGENTS.md`, `tasks/plan.md`, `tasks/todo.md`, `SPEC.md` | cabeçalhos mencionam "screenmirror" — estes são documentos do projeto; atualizar cabeçalhos para "Farol" onde se refere ao nome do produto |

Não renomear: nomes de pasta, variáveis de código interno, chaves de IPC, nomes de branches/git, strings de log não visíveis ao usuário (a menos que sejam expostos na UI).

### 7.2 Paleta (abordagem B)

Tokens CSS (CSS custom properties) usados em `host.css` e `viewer.css`:

```css
:root {
  --farol-bg: #0a0a0a;        /* fundo escuro profundo */
  --farol-surface: #141414;   /* superfície de card/panel */
  --farol-border: #2a2a2a;    /* borda sutil */
  --farol-text: #f5f5f5;      /* texto primário */
  --farol-muted: #9a9a9a;     /* texto secundário */
  --farol-accent: #ff9f43;    /* âmbar — destaque primário (botão, ponto ao vivo) */
  --farol-accent-hover: #ffb26e;
  --farol-success: #7cb342;   /* verde — ao vivo / conectado */
  --farol-error: #ff8a80;     /* vermelho suave — erro */
  --farol-notice: #ffcc80;    /* âmbar claro — aviso */
  --farol-focus: #ff9f43;     /* foco visível */
}
```

### 7.3 Interatividade

- Botões: hover escurece/clareia a superfície, `active` reduz opacidade ligeira, foco com outline âmbar visível de longa distância (10-foot UI).
- PIN slots: preenchidos mudam cor da borda para âmbar.
- Ponto "ao vivo" (viewer-pill / status) usa âmbar pulsante sutil ou verde sólido quando conectado.
- Transições de estado no viewer (pareando → conectando → assistindo) com fade/opacity suave.
- Mensagens de erro/aviso com cores de estado (erro / notice) já existentes, mantidas.

### 7.4 Layout

- Host: header com título "Farol", painel de emparelhamento (PIN grande, QR, URLs), seção de captura com controles agrupados e preview de vídeo.
- Viewer: tela de pareamento centralizada (10-foot UI), slots de PIN grandes, teclado numérico de botões, tela de reprodução com vídeo preenchendo a área e controles de sobreposição que somem após inatividade.

## 8. O que fica para o builder

- Escrever os tokens CSS e reescrever `host.css` e `viewer.css` com a paleta âmbar.
- Ajustar `App.tsx` e `PairPanel.tsx` apenas no necessário para usar as novas classes/cores (não mudar comportamento).
- Ajustar `main.tsx`, `PinPad.tsx`, `Watch.tsx` do viewer para as novas classes (sem mudar comportamento de pareamento/reprodução).
- Alterar textos de "screenmirror" para "Farol" nos arquivos listados em §7.1.
- Atualizar cabeçalhos de `AGENTS.md`, `SPEC.md`, `tasks/plan.md`, `tasks/todo.md` para refletir o novo nome do produto.
- Rodar `npm run verify` (lint + test + coverage + build + `check:gates`) e `npx tsc -p tsconfig.json` antes de considerar pronto.

## 9. Aprovação

Este design doc cobre a abordagem B e as partes do how já decididas. Nenhum código de produto será escrito até que você aprove.

Responda "aprovado" ou indique o que ajustar.

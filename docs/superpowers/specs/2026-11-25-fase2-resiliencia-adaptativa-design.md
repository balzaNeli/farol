# Design doc — Fase 2: resiliência de rede e qualidade adaptativa

**Data:** 2026-11-25
**Status:** abordagem A aprovada pelo parceiro humano em 2026-11-25

## 1. Intenção

Combinar a Otimização 4 (controle adaptativo de `scaleResolutionDownBy`), a Otimização 8
(segundo ICE restart / reconexão automática do viewer) e a Feature 4 (bitrate adaptativo) sem
alterar o contrato de sinalização, sem novas dependências runtime e sem enfraquecer
`CONSTRAINTS.md` / `EX-001`.

**Invariante:** em oscilação de LAN pura o host mantém **1080p fixo** e aceita queda de quadros.
`scaleResolutionDownBy > 1` continua existindo **apenas** sob
`qualityLimitationReason === "cpu"` no encoder do host (EX-001), voltando a `1.0` em `"none"`.
Bitrate é o único eixo que reage à rede.

## 2. Achado bloqueante

`src/renderer/mirror.ts` grava `params.scaleResolutionDownBy = 1.0` fixo no nível de cima de
`setParameters`, descartando o `1.5` que a válvula EX-001 calcula. Hoje a exceção está
documentada, mas é inerte. Corrigir isso é a primeira tarefa de código, com teste de
reprodução (RED) antes da correção.

## 3. Eixos independentes

| Eixo | Sinal | Ação | Mecanismo | Renegocia SDP? |
|------|-------|------|-----------|----------------|
| Rede (Feature 4) | `fractionLost` de `remote-inbound-rtp` e `qualityLimitationReason === "bandwidth"` no host | `maxBitrate` entre 1,5 e 5 Mbps | `sender.setParameters()` | Não |
| Encoder (EX-001 / Otim. 4) | `qualityLimitationReason === "cpu"` no host | `scaleResolutionDownBy` 1,5 ↔ 1,0 | `sender.setParameters()` | Não |
| Conectividade (Otim. 8) | `connectionState === "failed"` nos dois peers | até 2 ICE restarts, 8 s por tentativa | `restartIce()` + nova oferta do host | Sim (máx. 2) |

O host lê `remote-inbound-rtp` no mesmo `getStats()` de 3 s que já existe. Não há telemetria do
viewer, nem novo tipo de `Signal`, nem `getStats()` fora de `?debug=1` na Fire TV.

## 4. Decisão adaptativa (pura, em `src/shared/capture.ts`)

```ts
export const MIN_BITRATE_BPS = 1_500_000;
export type AdaptiveSample = { qualityLimitationReason?: string | null; fractionLost?: number | null };
export type AdaptiveState = {
  maxBitrateBps: number;
  scaleResolutionDownBy: 1.0 | 1.5;
  downStreak: number;
  upStreak: number;
};
export function initialAdaptiveState(): AdaptiveState;
export function nextAdaptive(
  state: AdaptiveState,
  sample: AdaptiveSample,
  quality: "native" | "1080p" | "720p",
): { state: AdaptiveState; apply: { maxBitrateBps: number; scaleResolutionDownBy: 1.0 | 1.5 } | null };
```

Regras:

- `native` → `apply: null`, estado inalterado (a fonte continua intocada).
- `scaleResolutionDownBy`: `1.5` somente com reason `"cpu"`; `1.0` em `"bandwidth"`, `"none"`,
  ausente, `null` ou desconhecido (fail closed). CPU → bandwidth/none volta a `1.0` na mesma
  amostra.
- Amostra ruim: `fractionLost > 0.02` ou reason `"bandwidth"`. Duas ruins consecutivas →
  `max(1_500_000, round(atual * 0.8))`.
- Amostra boa: reason `"none"` e `fractionLost !== null` e `< 0.005`. Cinco boas consecutivas →
  `min(5_000_000, round(atual * 1.1))`.
- `fractionLost` ausente/null não é evidência de rede: nem sobe nem desce e zera os dois streaks.
- Aplicar um degrau zera ambos os streaks; `apply` é `null` se nada mudou.
- Nenhuma regra escreve `degradationPreference` diferente de `"maintain-resolution"` e nenhuma
  chama `applyConstraints` — resolução de captura só muda por escolha explícita do usuário.

A função mora em `capture.ts` (já no ratchet de cobertura) em vez de um módulo novo: evita mudar
`package.json`, mantém as constantes de encoding juntas e não cria outro arquivo para o mesmo
domínio.

## 5. Integração no host (`src/renderer/mirror.ts`)

- `applyVideoBitrateCap(sender, bitrate, quality, scale)` passa a escrever o `scale` recebido no
  topo de `params` **e** em `encodings[0]` (o campo é válido nos dois lugares; o Chromium lê o
  topo e a especificação define o nível de encoding). `degradationPreference` continua só no
  topo.
- O timer de 3 s lê `outbound-rtp` (motivo, frames) e `remote-inbound-rtp` (`fractionLost`) de vídeo,
  monta o sample e chama `nextAdaptive`. Se `apply !== null`, aplica via uma fila serial
  `paramsChain`, que também é usada por `setQuality()` e capturada pelo contador de geração.
- `setQuality()` e `release()` reiniciam o estado adaptativo; falha de `setParameters()` no timer
  é best-effort (sem erro na UI a cada 3 s).
- O contador de ICE restart do host vira número (0..2) usando `canRestartIce()`; no terceiro
  `failed`, encerra com erro.

## 6. Reconexão do viewer (`connection.ts` + `Watch.tsx`)

- `MAX_ICE_RESTARTS = 2`, `canRestartIce(restarts)`, novo evento `"checking"` e campo opcional
  `rearmed`. `checking` só marca que o restart chegou ao handshake; **não** cancela o timeout.
- `failed` concede um restart somente se houver orçamento e, quando já em `reconnecting`, o
  evento `checking` tiver ocorrido. Duplicata do outro handler vai para `lost` sem gastar
  orçamento. `connected` zera tudo; `timeout` em `reconnecting` vai para `lost`.
- Os testes atuais continuam válidos: sem `checking`, o segundo `failed` ainda termina em `lost`.
- `Watch.tsx` dispara `transition("checking")` em `iceConnectionState === "checking"`, chama
  `restartIce()` só quando o reducer aumentou `restarts`, rearma o timer de 8 s por tentativa e
  mostra `Reconnecting... (n/2)`. Nenhuma API de captura de mídia é introduzida.
- Após `lost`, o usuário volta ao PIN pad: o token é single-use, não há re-pair automático.

## 7. Fora de escopo

Telemetria do viewer por sinalização, `getStats()` contínuo no viewer, redução de resolução por
rede, `applyConstraints` automático, `maintain-framerate-and-resolution`, 3+ restarts, Feature 5
(reconexão rápida sem PIN), Features 2/6 e mudanças em `CONSTRAINTS.md`.

## 8. Verificação

TDD em cada item; cobertura dos módulos puros ≥ 95,88% (ratchet), zero warnings no lint,
`npx tsc -p tsconfig.json` limpo, `npm run verify` verde e commits com `--no-gpg-sign`.
Medição manual na Fire TV fica registrada como pendente em `docs/manual-tests.md`: oscilação de
LAN com 1080p fixo, dois restarts e terceira queda → tela de reconexão.

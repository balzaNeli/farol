# Host Layout Design

## Intent

Reorganizar a janela Host em um painel desktop compacto, equilibrado e sem rolagem na janela padrão, tornando pareamento e transmissão fáceis de localizar.

## Goals

- Usar cabeçalho minimalista e grade centralizada de até 960px com duas colunas em desktop.
- Concentrar QR, PIN, expiração, endereços e cópia em card escuro.
- Concentrar fonte, atualização, qualidade, áudio, ação principal, estado, avisos e preview em card claro.
- Mostrar placeholder de monitor quando a captura não está ativa e o vídeo apenas enquanto ativa.
- Preservar lógica e integração atuais com `mirror.ts`, IPC, captura e WebRTC.

## Non-goals and anti-goals

- Alterar `mirror.ts`, IPC, captura, WebRTC, servidor ou fluxo do viewer.
- Adicionar dependência runtime, requisições externas ou qualquer permissão de captura no viewer.
- Manter a apresentação vertical atual ou um preview preto vazio em estado inativo.

## Constraints

- Seguir `CONSTRAINTS.md`, `DESIGN.md`, `SPEC.md` e as instruções de `AGENTS.md`.
- Usar fontes locais do sistema, tokens de design, CSP existente e `RTC_CONFIG.iceServers` vazio.
- Preservar estados, refs e handlers de `App.tsx`; a cópia da URL é a única ação visual nova e usará clipboard local.
- `npm run verify` e `npx tsc -p tsconfig.json` devem passar sem relaxar gates.

## Approaches

1. **Reutilizar `PairPanel` e reestruturar `App`/CSS (selecionado):** mantém o cálculo de PIN, QR e expiração co-localizado e limita a mudança estrutural a App e estilos, com inclusão de uma ação compacta de cópia no painel.
2. **Mover todo pareamento para `App`:** dá controle visual total, mas duplica e espalha o estado temporal/QR existente.
3. **Apenas aplicar CSS ao DOM atual:** preserva a árvore atual e não resolve adequadamente as novas interações e a hierarquia dos dois cards.

## Design

No desktop, `header` ocupa toda a largura; abaixo, uma grade com coluna de pareamento de aproximadamente 360px e coluna flexível de controles. O card esquerdo tem superfície `#1d1d1f`/`#272729`, QR central, PIN destacado, contador discreto e URL com botão Copiar e feedback. O card direito usa superfície branca, borda `#e0e0e0` e raio 18px; fonte e atualizar formam uma linha, qualidade usa chips selecionáveis, áudio usa switch, e Start/Stop é a ação em pílula. Status, erros e avisos ficam numa região dedicada. Preview inativo é um placeholder; ativo exibe o `video` existente. Em telas estreitas, a grade empilha e a página pode rolar.

## Builder decisions

- Preservar a assinatura e os handlers atuais; adicionar apenas o necessário à cópia da URL e ao estado visual de sucesso/erro.
- Usar SVG inline como ícone de atualizar/monitor, sem dependência nem recurso remoto.
- Manter os textos operacionais existentes sempre que possível; renomear labels e a ação conforme os rótulos pedidos.

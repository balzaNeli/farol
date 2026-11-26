import type { Quality } from "./ipc.ts";

/**
 * The capture side of the quality selector. `null` means "leave the source alone"; every other
 * value is a cap applied with `track.applyConstraints`, never a new getDisplayMedia call.
 */
export function videoConstraints(quality: Quality): MediaTrackConstraints | null {
  if (quality === "native") return null;
  const [width, height] = quality === "1080p" ? [1920, 1080] : [1280, 720];
  return { width: { max: width }, height: { max: height }, frameRate: { ideal: 30, max: 30 } };
}

/** Teto e piso de bitrate do encoder de vídeo do host (opção b: 1080p mantido, nunca reduzido). */
export const TARGET_BITRATE_BPS = 5_000_000;
export const MIN_BITRATE_BPS = 1_500_000;

/**
 * Únicos valores de escala permitidos: 1.0 mantém a resolução; 1.5 é a válvula EX-001, restrita
 * à pressão de CPU do encoder. Tipar como literal impede que uma decisão de rede escreva 1.5.
 */
export type EncoderScale = 1.0 | 1.5;

/** Parâmetros de encoding do sender de vídeo: bitrate adaptativo, 30 fps, resolução preservada. */
export type VideoEncodingParams = RTCRtpEncodingParameters & {
  degradationPreference: "maintain-resolution" | "maintain-framerate" | "balanced";
  scaleResolutionDownBy: EncoderScale;
};

export function videoEncodingParams(
  maxBitrateBps: number,
  scaleResolutionDownBy: EncoderScale = 1.0,
): VideoEncodingParams {
  return {
    maxBitrate: maxBitrateBps,
    maxFramerate: 30,
    // "maintain-resolution": sob pressão, o Chromium reduz fps, não resolução (opção b).
    // O padrão é 1.0 (sem redução); 1.5 só acontece sob pressão de CPU do encoder (EX-001).
    degradationPreference: "maintain-resolution",
    scaleResolutionDownBy,
  };
}

/**
 * Decisão adaptativa pura. Recebe apenas o que o host lê em `getStats()` (motivo de limitação do
 * outbound-rtp e perda de pacotes do remote-inbound-rtp) e devolve o próximo estado + o que deve
 * ser aplicado. Nunca mexe em constraints de captura: resolução de rede é 1080p fixo.
 */
export type AdaptiveSample = {
  qualityLimitationReason?: string | null;
  fractionLost?: number | null;
};

/** EX-001: duas amostras cpu antes de escalar; três ticks de cooldown após a recuperação. */
export const CPU_SAMPLES_TO_SCALE = 2;
export const CPU_SCALE_COOLDOWN_TICKS = 3;

export type AdaptiveState = {
  maxBitrateBps: number;
  scaleResolutionDownBy: EncoderScale;
  downStreak: number;
  upStreak: number;
  cpuStreak: number;
  cpuCooldownTicks: number;
};

export type AdaptiveApply = { maxBitrateBps: number; scaleResolutionDownBy: EncoderScale };

export function initialAdaptiveState(): AdaptiveState {
  return {
    maxBitrateBps: TARGET_BITRATE_BPS,
    scaleResolutionDownBy: 1.0,
    downStreak: 0,
    upStreak: 0,
    cpuStreak: 0,
    cpuCooldownTicks: 0,
  };
}

/**
 * Histerese: 2 amostras ruins (perda > 2% ou reason "bandwidth") derrubam 20%; 5 boas (reason
 * "none" com perda < 0,5%) sobem 10%. Sem evidência de perda, nada muda. `scale` só sai de 1.0
 * com 2 amostras cpu consecutivas — a exceção EX-001 — e volta a 1.0 na mesma amostra em
 * qualquer outro motivo; a recuperação abre um cooldown para não reconfigurar o encoder em flap.
 */
export function nextAdaptive(
  state: AdaptiveState,
  sample: AdaptiveSample,
  quality: Quality,
): { state: AdaptiveState; apply: AdaptiveApply | null } {
  if (quality === "native") return { state, apply: null };

  const reason = sample.qualityLimitationReason;
  const fractionLost = typeof sample.fractionLost === "number" ? sample.fractionLost : null;
  const cpu = reason === "cpu";
  const cpuStreak = cpu ? state.cpuStreak + 1 : 0;
  let cpuCooldownTicks = Math.max(0, state.cpuCooldownTicks - 1);
  let scaleResolutionDownBy: EncoderScale = state.scaleResolutionDownBy;
  if (!cpu) {
    // EX-001 é restritiva: qualquer outro motivo (inclusive ausente) devolve 1.0 de imediato.
    scaleResolutionDownBy = 1.0;
    if (state.scaleResolutionDownBy === 1.5) cpuCooldownTicks = CPU_SCALE_COOLDOWN_TICKS;
  } else if (cpuCooldownTicks === 0 && cpuStreak >= CPU_SAMPLES_TO_SCALE) {
    scaleResolutionDownBy = 1.5;
  }
  const bad = reason === "bandwidth" || (fractionLost !== null && fractionLost > 0.02);
  const good = reason === "none" && fractionLost !== null && fractionLost < 0.005;

  let maxBitrateBps = state.maxBitrateBps;
  let downStreak = bad ? state.downStreak + 1 : 0;
  let upStreak = good ? state.upStreak + 1 : 0;
  if (downStreak >= 2) {
    maxBitrateBps = Math.max(MIN_BITRATE_BPS, Math.round(maxBitrateBps * 0.8));
    downStreak = 0;
    upStreak = 0;
  } else if (upStreak >= 5) {
    maxBitrateBps = Math.min(TARGET_BITRATE_BPS, Math.round(maxBitrateBps * 1.1));
    downStreak = 0;
    upStreak = 0;
  }

  const next: AdaptiveState = {
    maxBitrateBps,
    scaleResolutionDownBy,
    downStreak,
    upStreak,
    cpuStreak,
    cpuCooldownTicks,
  };
  const changed =
    maxBitrateBps !== state.maxBitrateBps || scaleResolutionDownBy !== state.scaleResolutionDownBy;
  return { state: next, apply: changed ? { maxBitrateBps, scaleResolutionDownBy } : null };
}

/** Contadores de envio já validados; `bytesSent: null` significa que o stats não trouxe o campo. */
export type SendCounters = { framesEncoded: number; bytesSent: number | null; timestamp: number };

export type SendSample = {
  framesEncoded?: number;
  bytesSent?: number;
  timestamp?: number;
  qualityLimitationReason?: string | null;
};

export type SendMetrics = {
  fps: number | null;
  bitrateBps: number | null;
  limitReason: string | null;
};

/**
 * Deriva fps e bitrate de duas leituras do outbound-rtp (timestamp em ms). Função pura: não
 * arredonda, não aplica nada ao sender e nunca inventa uma taxa sem um delta positivo de tempo.
 */
export function readSendMetrics(
  previous: SendCounters | null,
  sample: SendSample,
): { counters: SendCounters | null; metrics: SendMetrics } {
  const reason = sample.qualityLimitationReason;
  const limitReason = typeof reason === "string" ? reason : null;
  const framesEncoded = sample.framesEncoded;
  const timestamp = sample.timestamp;

  if (
    typeof framesEncoded !== "number" ||
    !Number.isFinite(framesEncoded) ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp)
  ) {
    return { counters: null, metrics: { fps: null, bitrateBps: null, limitReason } };
  }

  const rawBytes = sample.bytesSent;
  const bytesSent =
    typeof rawBytes === "number" && Number.isFinite(rawBytes) ? rawBytes : null;
  const counters: SendCounters = { framesEncoded, bytesSent, timestamp };

  if (previous === null || timestamp <= previous.timestamp) {
    return { counters, metrics: { fps: null, bitrateBps: null, limitReason } };
  }

  const seconds = (timestamp - previous.timestamp) / 1000;
  const deltaFrames = framesEncoded - previous.framesEncoded;
  const fps = deltaFrames >= 0 ? deltaFrames / seconds : null;

  let bitrateBps: number | null = null;
  if (bytesSent !== null && previous.bytesSent !== null) {
    const deltaBytes = bytesSent - previous.bytesSent;
    if (deltaBytes >= 0) bitrateBps = (deltaBytes * 8) / seconds;
  }

  return { counters, metrics: { fps, bitrateBps, limitReason } };
}

/** Detecta se a fonte capturada é uma janela específica (não a tela inteira). */
export function isWindowSurface(displaySurface: string | null | undefined): boolean {
  return displaySurface === "window";
}

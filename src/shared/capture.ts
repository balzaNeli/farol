import type { Quality } from "./ipc.ts";

/**
 * The capture side of the quality selector. `null` means "leave the source alone"; every other
 * value is a cap applied with `track.applyConstraints`, never a new getDisplayMedia call.
 */
export function videoConstraints(quality: Quality): MediaTrackConstraints | null {
  if (quality === "native") return null;
  const [width, height] = quality === "1080p" ? [1920, 1080] : [1280, 720];
  return { width: { max: width }, height: { max: height }, frameRate: { max: 30 } };
}

/** Teto fixo de bitrate do encoder de vídeo do host (opção b: 1080p mantido, nunca reduzido). */
export const TARGET_BITRATE_BPS = 5_000_000;

/** Parâmetros de encoding do sender de vídeo: bitrate fixo, 30 fps, sem redução de resolução (opção b). */
export function videoEncodingParams(maxBitrateBps: number): RTCRtpEncodingParameters {
  return {
    maxBitrate: maxBitrateBps,
    maxFramerate: 30,
    // "maintain-resolution": sob pressão, o Chromium reduz fps, não resolução (opção b).
    // scaleResolutionDownBy: 1.0 garante que a resolução nunca seja baixada como válvula de escape.
    degradationPreference: "maintain-resolution",
    scaleResolutionDownBy: 1.0,
  };
}

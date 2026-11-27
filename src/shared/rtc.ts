/**
 * The whole ICE configuration, frozen so no code path can quietly add a STUN/TURN server and
 * leak the session off the LAN. `npm run verify` greps the build output to keep it that way.
 */
export const RTC_CONFIG: Readonly<RTCConfiguration> = Object.freeze({
  // Freezing the array too: RTCConfiguration demands a mutable array type, so this is asserted.
  iceServers: Object.freeze([] as RTCIceServer[]),
}) as Readonly<RTCConfiguration>;

/** Orçamento compartilhado host/viewer: 2 tentativas por episódio, 8 s cada uma no viewer. */
export const MAX_ICE_RESTARTS = 2;

export function canRestartIce(restarts: number): boolean {
  return restarts < MAX_ICE_RESTARTS;
}

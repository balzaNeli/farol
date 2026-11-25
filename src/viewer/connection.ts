import { canRestartIce, MAX_ICE_RESTARTS } from "../shared/rtc.ts";

export { canRestartIce, MAX_ICE_RESTARTS };

export type ConnectionPhase = "connecting" | "connected" | "reconnecting" | "lost";

export type ConnectionState = {
  phase: ConnectionPhase;
  restarts: number;
  /** Presente só depois de um restart ter chegado a "checking" — deduplica eventos failed. */
  rearmed?: boolean;
};

export type ConnectionEvent = "connected" | "checking" | "failed" | "duplicate" | "timeout";

/**
 * O handler de `connectionstatechange` e o de `iceconnectionstatechange` podem reportar a mesma
 * queda. Enquanto um restart está pendente, o segundo evento é uma duplicata — não pode gastar
 * o orçamento nem chegar à tela de reconexão antes do `checking`.
 */
export function failureEvent(restartPending: boolean): "failed" | "duplicate" {
  return restartPending ? "duplicate" : "failed";
}

export const initialConnection: ConnectionState = { phase: "connecting", restarts: 0 };

/**
 * Até dois ICE restarts por episódio. `checking` marca que a tentativa chegou ao handshake: só
 * um `failed` depois disso vale como nova queda; sem `checking`, um `failed` em `reconnecting`
 * é a segunda queda e vai para `lost`. O evento `duplicate` do outro handler é ignorado e não
 * gasta orçamento. Um timeout em `reconnecting` também é terminal.
 */
export function connectionReducer(
  state: ConnectionState,
  event: ConnectionEvent,
): ConnectionState {
  if (event === "connected") {
    return state.phase === "connected" && state.restarts === 0 && state.rearmed === undefined
      ? state
      : { phase: "connected", restarts: 0 };
  }
  if (event === "checking") {
    if (state.phase !== "reconnecting" || state.rearmed === true) return state;
    return { ...state, rearmed: true };
  }
  if (event === "duplicate") return state;
  if (event === "failed") {
    if (state.phase === "lost") return state;
    if (state.phase === "reconnecting" && state.rearmed !== true) {
      return { phase: "lost", restarts: state.restarts };
    }
    if (!canRestartIce(state.restarts)) return { phase: "lost", restarts: state.restarts };
    return { phase: "reconnecting", restarts: state.restarts + 1 };
  }
  return state.phase === "reconnecting" ? { phase: "lost", restarts: state.restarts } : state;
}

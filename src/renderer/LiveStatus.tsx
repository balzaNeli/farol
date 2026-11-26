import type { SendMetrics } from "../shared/capture.ts";
import type { Quality } from "../shared/ipc.ts";
import type { MirrorStatus } from "./mirror.ts";

const EMPTY = "—";

function encoderLabel(reason: string | null): string {
  if (reason === "none") return "Stable";
  if (reason === "bandwidth") return "Network";
  if (reason === "cpu") return "CPU-limited";
  return EMPTY;
}

/** Read-only view of the metrics already emitted by the host's 3 s getStats() timer. */
export function LiveStatus({
  status,
  quality,
  audio,
  metrics,
}: {
  status: MirrorStatus;
  quality: Quality;
  audio: boolean;
  metrics: SendMetrics | null;
}) {
  const live = status === "idle" || status === "error" ? null : metrics;
  const fps = live?.fps ?? null;
  const bitrateBps = live?.bitrateBps ?? null;
  const fpsText =
    typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? `${fps.toFixed(0)} fps` : EMPTY;
  const bitrateText =
    typeof bitrateBps === "number" && Number.isFinite(bitrateBps) && bitrateBps > 0
      ? `${(bitrateBps / 1_000_000).toFixed(1).replace(".", ",")} Mbps`
      : EMPTY;

  return (
    <dl className="live-status" aria-label="Live transmission status">
      <dt>Send</dt>
      <dd>{fpsText}</dd>
      <dt>Bitrate</dt>
      <dd>{bitrateText}</dd>
      <dt>Quality</dt>
      <dd>{live !== null ? quality : EMPTY}</dd>
      <dt>Audio</dt>
      <dd>{live !== null ? (audio ? "On" : "Off") : EMPTY}</dd>
      <dt>Encoder</dt>
      <dd>{live !== null ? encoderLabel(live.limitReason) : EMPTY}</dd>
    </dl>
  );
}

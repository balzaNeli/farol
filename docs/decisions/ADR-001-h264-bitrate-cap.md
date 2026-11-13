# ADR-001: Fixed 5 Mbps H.264 bitrate cap for 1080p30 host encoding

## Status
Accepted

## Date
2026-11-13

## Context
The Farol host (Windows 11) captures screen + system audio via `getDisplayMedia` and encodes H.264 for WebRTC delivery to a Fire TV AFTCA002 viewer. The viewer is receive-only; the Fire TV never encodes. The SoC is weak and has suffered hard freezes (requiring physical power cycle) when forced to act as sender/encoder.

Reported symptom: frame drops in the H.264 1080p30 stream. Suspected cause: the host encoder sends unbounded variable bitrate (VBR), inundating the Fire TV decoder buffer and causing packet loss on the LAN. Without a bitrate ceiling or reception feedback, the stream never self-recovers.

The human partner chose option (b): keep 1080p resolution, accept frame drops when the LAN oscillates. Resolution is never reduced as an escape valve.

## Decision
Apply a fixed bitrate ceiling of **5 Mbps** (5,000,000 bps) at 30 fps to the host's video `RTCRtpSender` via `RTCRtpSender.setParameters()`, combined with `video.contentHint = "motion"` so Chromium drops visual quality rather than frames when the encoder is pressured.

Key implementation details:
- `TARGET_BITRATE_BPS = 5_000_000` and `videoEncodingParams()` in `src/shared/capture.ts` (pure module).
- `applyVideoBitrateCap(sender, maxBitrateBps, quality)` helper in `src/renderer/mirror.ts`: reads current sender parameters via `getParameters()`, injects `maxBitrate` into `encodings[0]` (injecting `[{}]` if the encodings array is empty before SDP negotiation), applies via `setParameters()`.
- `contentHint = "motion"` on the capture track, replacing the previous `"detail"`.
- `quality === "native"` leaves the source untouched: no `maxBitrate` or `maxFramerate` injection via `setParameters`.
- In `start()`: `setParameters` failure emits a non-critical UI error but does **not** abort the stream (returns `ok: true`). Availability is prioritized over the absolute cap.
- In `setQuality()`: `setParameters` failure returns `false`, letting `changeQuality()` in `App.tsx` revert the UI label.
- No STUN/TURN (`RTC_CONFIG.iceServers` stays empty and frozen). Viewer remains receive-only. No resolution reduction as a valve.

## Alternatives Considered

### Option A — Fixed bitrate 5 Mbps + short GOP + fast PLI (CHOSEN)
- Pros: Simple, predictable, sender controls the ceiling, viewer stays dumb/receive-only, no new signaling channel, respects the "viewer is dumbest possible" non-negotiable.
- Cons: If the LAN drops below 5 Mbps, frames drop until the next keyframe; no automatic recovery.
- Selected because it resolves the bottleneck at the sender and preserves the viewer-as-passive-receiver rule.

### Option B — Light ABR keeping 1080p
- Pros: Better chance of maintaining smoothness on an unstable LAN.
- Cons: Requires a return signaling channel from viewer to host (doesn't exist today), more complex, viewer is no longer purely passive. Deferred: only enters if option A proves insufficient on the physical LAN.

### Option C — Encoder tuning (profile/level, zerolatency, simulcast)
- Pros: Could improve encoder efficiency.
- Cons: `simulcast` is complex in a receive-only answerer; profile/level isn't directly controllable via standard WebRTC APIs; `preferH264` already handles codec selection. Deferred.

## Consequences
- Host encoder is capped at 5 Mbps / 30 fps for 1080p and 720p qualities; `native` is exempt (source left alone).
- `contentHint = "motion"` biases the encoder toward dropping quality, not frames, under pressure.
- `setParameters` does not traverse the SDP offer; it affects the local media engine only. Negotiation is unchanged.
- Viewer telemetry (`framesDecoded` / `framesDropped`) is available under `?debug=1` to validate whether option A suffices before considering option B.
- No new runtime dependencies. All non-negotiables (empty `iceServers`, receive-only viewer, host on `file://`, verbatim signaling, CSP strict, button PIN pad) remain intact.
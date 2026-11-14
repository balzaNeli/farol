import { preferH264 } from "../shared/codecs.ts";
import { TARGET_BITRATE_BPS, videoConstraints, videoEncodingParams } from "../shared/capture.ts";
import type { Quality, StartRequest } from "../shared/ipc.ts";
import type { Signal } from "../shared/protocol.ts";
import { RTC_CONFIG } from "../shared/rtc.ts";

export type MirrorStatus = "idle" | "starting" | "waiting" | "live" | "reconnecting" | "error";

export type MirrorState = { status: MirrorStatus; error: string | null; audio: boolean };

export type MirrorResult =
  | { ok: true; stream: MediaStream; audio: boolean }
  | { ok: false; error: string };

export type Mirror = {
  start: (request: StartRequest) => Promise<MirrorResult>;
  stop: () => void;
  setAudio: (on: boolean) => Promise<boolean>;
  setQuality: (quality: Quality) => Promise<boolean>;
  handleSignal: (signal: Signal) => void;
  onChange: (listener: (state: MirrorState) => void) => void;
  getEncoderStats: () => {
    qualityLimitationReason: string | null;
    framesEncoded: number;
    totalEncodeTime: number;
  } | null;
  getSurfaceType: () => "screen" | "window" | null;
};

/** Browser capture errors are DOMExceptions; show the user what to do, not the exception name. */
export function captureErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Screen capture was denied. Allow screen recording for Farol and try again.";
    }
    if (err.name === "NotFoundError") {
      return "No screen or window was available. Refresh the source list and try again.";
    }
    if (err.name === "NotReadableError") {
      return "The screen could not be read. Close other capture apps and try again.";
    }
    if (err.name === "AbortError") return "Screen capture was canceled.";
  }
  const detail = err instanceof Error && err.message !== "" ? err.message : "";
  return detail === "" ? "Screen capture failed." : `Screen capture failed: ${detail}`;
}

/**
 * Host-side capture engine. The renderer owns the peer connection; main only grants the selected
 * source. One engine per window, driving one viewer at a time.
 */
export function createMirror(): Mirror {
  const listeners = new Set<(state: MirrorState) => void>();
  let state: MirrorState = { status: "idle", error: null, audio: false };
  let generation = 0;
  let pc: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  let audioSender: RTCRtpSender | null = null;
  let viewerPresent = false;
  let offered = false;
  let offering = false;
  let answered = false;
  let statsTimer: number | null = null;
  let lastSurfaceType: "screen" | "window" | null = null;
  let lastEncoderStats:
    | (RTCOutboundRtpStreamStats & {
        qualityLimitationReason?: string;
        framesEncoded?: number;
        totalEncodeTime?: number;
      })
    | null = null;

  // The host starts capture before the viewer joins (SPEC user story), so the offer waits for a
  // viewer seat instead of being dropped by the signaling server.
  window.mirror.onState((next) => {
    viewerPresent = next.viewer !== null;
    if (viewerPresent && pc !== null && !offered && !answered) void offer();
  });

  function emit(patch: Partial<MirrorState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function release(): void {
    if (statsTimer !== null) {
      window.clearInterval(statsTimer);
      statsTimer = null;
    }
    lastSurfaceType = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    audioSender = null;
    audioTrack = null;
    videoTrack = null;
    stream = null;
    pc?.close();
    pc = null;
    offered = false;
    offering = false;
    answered = false;
  }

  function fail(message: string): void {
    generation += 1;
    release();
    window.mirror.stop();
    emit({ status: "error", error: message, audio: false });
  }

  function endLocal(): void {
    generation += 1;
    release();
    window.mirror.stop();
    emit({ status: "idle", error: null, audio: false });
  }

  function stopped(): MirrorResult {
    return { ok: false, error: "cancelled" };
  }

  /**
   * Aplica o teto de bitrate fixo ao sender de vídeo. `native` deixa a fonte em paz:
   * não injeta maxFramerate nem maxBitrate via setParameters.
   * Trata params.encodings vazio (antes da negociação SDP) injetando um encoding vazio.
   */
  async function applyVideoBitrateCap(
    sender: RTCRtpSender,
    maxBitrateBps: number,
    quality: Quality,
  ): Promise<void> {
    if (quality === "native") return; // deixe a fonte em paz
    const params = sender.getParameters();
    if (!(params.encodings?.length)) {
      params.encodings = [{}];
    }
    params.encodings[0] = {
      ...params.encodings[0],
      ...videoEncodingParams(maxBitrateBps),
    };
    await sender.setParameters(params);
  }

  async function offer(restart = false): Promise<boolean> {
    const peer = pc;
    if (peer === null || offering) return true;
    if (!restart && (offered || answered)) return true;
    if (peer.signalingState !== "stable") return true;

    offering = true;
    try {
      if (restart) peer.restartIce();
      const local = await peer.createOffer();
      await peer.setLocalDescription(local);
      if (peer !== pc) return false;
      offered = true;
      if (peer.localDescription !== null) {
        window.mirror.sendSignal({ type: "offer", sdp: peer.localDescription.sdp });
      }
      emit({ status: restart ? "reconnecting" : "waiting", error: null });
      return true;
    } catch (err) {
      if (peer === pc) fail(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      offering = false;
    }
  }

  async function start(request: StartRequest): Promise<MirrorResult> {
    const run = ++generation;
    release();
    emit({ status: "starting", error: null, audio: false });

    try {
      // Main picks the source; an unsupported OS may quietly drop the audio request.
      const granted = await window.mirror.start(request);
      if (run !== generation) return stopped();

      const capture = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: granted.audio,
      });
      if (run !== generation) {
        for (const track of capture.getTracks()) track.stop();
        window.mirror.stop();
        return stopped();
      }

      const video = capture.getVideoTracks()[0];
      if (video === undefined) throw new Error("display capture returned no video track");
      // "motion" instrui o Chromium a derrubar qualidade visual, não quadros, quando o encoder
      // estiver pressionado. Complementa o teto de bitrate fixo (5 Mbps) sem reduzir a resolução.
      video.contentHint = "motion";

      // Detecta se a fonte capturada é uma janela específica (não a tela inteira) para o aviso
      // de ~17 fps no Windows (Wayland/HWND path do Chromium limita janelas específicas).
      lastSurfaceType = video.getSettings().displaySurface === "window" ? "window" : "screen";

      const constraints = videoConstraints(request.quality);
      if (constraints !== null) await video.applyConstraints(constraints);
      if (run !== generation) {
        for (const track of capture.getTracks()) track.stop();
        window.mirror.stop();
        return stopped();
      }

      const peer = new RTCPeerConnection(RTC_CONFIG);
      if ((peer.getConfiguration().iceServers ?? []).length > 0) {
        throw new Error("iceServers must stay empty");
      }
      let iceRestarted = false;

      peer.addTrack(video, capture);
      const videoSender = peer.getSenders().find((sender) => sender.track === video);
      if (videoSender !== undefined) {
        // maxBitrate afeta apenas o empacotador/encoder local; não trafega no SDP da oferta.
        try {
          await applyVideoBitrateCap(videoSender, TARGET_BITRATE_BPS, request.quality);
        } catch (err) {
          // Não impede o início da transmissão: apenas aviso não-crítico para a UI.
          const message = err instanceof Error ? err.message : String(err);
          emit({ error: `Bitrate cap not applied: ${message}` });
        }

        // Instrumentação do encoder: outbound-rtp expõe qualityLimitationReason, framesEncoded,
        // totalEncodeTime. qualityLimitationReason === "cpu" aponta para encoder do Windows;
        // "none" significa que o host não está limitado localmente. Últimas stats ficam
        // disponíveis em lastEncoderStats para diagnóstico.
        statsTimer = window.setInterval(async () => {
          try {
            const report = await videoSender.getStats();
            report.forEach((entry) => {
              if (entry.type === "outbound-rtp" && entry.kind === "video") {
                lastEncoderStats = entry as RTCOutboundRtpStreamStats & {
                  qualityLimitationReason?: string;
                  framesEncoded?: number;
                  totalEncodeTime?: number;
                };
              }
            });
          } catch {
            // stats são best-effort; uma conexão fechada rejeita getStats()
          }
        }, 1000);
      }
      const audio = capture.getAudioTracks()[0] ?? null;
      if (audio !== null) audioSender = peer.addTrack(audio, capture);

      const transceiver = peer.getTransceivers().find((entry) => entry.sender.track === video);
      const capabilities = RTCRtpSender.getCapabilities("video");
      if (transceiver !== undefined && capabilities !== null) {
        transceiver.setCodecPreferences(preferH264(capabilities.codecs));
      }

      peer.onicecandidate = (event) => {
        if (event.candidate !== null) {
          const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = event.candidate;
          window.mirror.sendSignal({
            type: "ice",
            candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment },
          });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer !== pc) return;
        if (peer.connectionState === "connected") {
          iceRestarted = false;
          emit({ status: "live", error: null });
        }
        if (peer.connectionState === "failed") {
          if (iceRestarted) {
            fail("Peer connection failed");
            return;
          }
          // The host is the offerer: one ICE restart per failure, then give up. The viewer
          // requests the matching restart on its own failed state.
          iceRestarted = true;
          void offer(true);
        }
      };

      pc = peer;
      stream = capture;
      videoTrack = video;
      audioTrack = audio;

      if (viewerPresent) {
        const sent = await offer();
        if (run !== generation) return stopped();
        if (!sent) return { ok: false, error: state.error ?? "could not send the offer" };
      }

      emit({ status: "waiting", error: null, audio: audio !== null });
      return { ok: true, stream: capture, audio: audio !== null };
    } catch (err) {
      if (run !== generation) return stopped();
      const message = captureErrorMessage(err);
      fail(message);
      return { ok: false, error: message };
    }
  }

  function stop(): void {
    if (pc !== null && (offered || viewerPresent)) {
      window.mirror.sendSignal({ type: "stop", reason: "host stopped" });
    }
    endLocal();
  }

  async function setAudio(on: boolean): Promise<boolean> {
    if (on && (audioSender === null || audioTrack === null)) return false;
    // Main answers with the resulting audio state: false for "off" is success, not refusal.
    const available = await window.mirror.setAudio(on);
    if (on && !available) return false;
    if (audioSender === null || audioTrack === null) return true;

    await audioSender.replaceTrack(on ? audioTrack : null);
    audioTrack.enabled = on;
    emit({ audio: on });
    return true;
  }

  async function setQuality(quality: Quality): Promise<boolean> {
    if (videoTrack === null) return true;
    const constraints = videoConstraints(quality);
    try {
      // Empty constraints clear the cap; the capture may keep its current size until it changes.
      await videoTrack.applyConstraints(constraints ?? {});
      // Reaplica o teto de bitrate fixo ao trocar a qualidade (o bitrate permanece 5 Mbps).
      const videoSender = pc?.getSenders().find((sender) => sender.track === videoTrack);
      if (videoSender !== undefined) {
        try {
          await applyVideoBitrateCap(videoSender, TARGET_BITRATE_BPS, quality);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit({ error: `Could not change quality to ${quality}: ${message}` });
          return false;
        }
      }
      emit({ error: null });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ error: `Could not change quality to ${quality}: ${message}` });
      return false;
    }
  }

  async function applyAnswer(sdp: string): Promise<void> {
    const peer = pc;
    if (peer === null) return;
    try {
      await peer.setRemoteDescription({ type: "answer", sdp });
      answered = true;
    } catch {
      if (peer === pc) fail("Could not apply the viewer's answer");
    }
  }

  function handleSignal(signal: Signal): void {
    if (signal.type === "answer") {
      void applyAnswer(signal.sdp);
    } else if (signal.type === "ice") {
      if (pc !== null) void pc.addIceCandidate(signal.candidate).catch(() => undefined);
    } else if (signal.type === "bye" || signal.type === "stop") {
      endLocal();
    }
  }

  return {
    start,
    stop,
    setAudio,
    setQuality,
    handleSignal,
    onChange: (listener) => {
      listeners.add(listener);
      listener(state);
    },
    getEncoderStats: () => {
      if (lastEncoderStats === null) return null;
      return {
        qualityLimitationReason: lastEncoderStats.qualityLimitationReason ?? null,
        framesEncoded: lastEncoderStats.framesEncoded ?? 0,
        totalEncodeTime: lastEncoderStats.totalEncodeTime ?? 0,
      };
    },
    getSurfaceType: () => lastSurfaceType,
  };
}

import { preferH264 } from "../shared/codecs.ts";
import {
  initialAdaptiveState,
  nextAdaptive,
  type AdaptiveState,
  type EncoderScale,
  TARGET_BITRATE_BPS,
  videoConstraints,
  videoEncodingParams,
} from "../shared/capture.ts";
import type { Quality, StartRequest } from "../shared/ipc.ts";
import type { Signal } from "../shared/protocol.ts";
import { canRestartIce, RTC_CONFIG } from "../shared/rtc.ts";

export type MirrorStatus = "idle" | "starting" | "waiting" | "live" | "reconnecting" | "error";

export type MirrorState = {
  status: MirrorStatus;
  error: string | null;
  audio: boolean;
  lowFpsWarning: string | null;
};

export type MirrorResult =
  | { ok: true; stream: MediaStream; audio: boolean }
  | { ok: false; error: string };

/** Resultado de `offer()`: apenas `sent` representa uma oferta (ou restart) realmente enviada. */
type OfferOutcome = "sent" | "skipped" | "failed";

/** RTCRtpSendParameters com campos que o Chromium lê no nível de cima de params. */
type RtcSenderParams = RTCRtpSendParameters & {
  degradationPreference?: "maintain-resolution" | "maintain-framerate" | "balanced";
  scaleResolutionDownBy?: number;
};

/** RTCRtpEncodingParameters com campos que o Chromium ignora dentro de encodings[0]. */
type RtcEncodingParams = RTCRtpEncodingParameters & {
  degradationPreference?: "maintain-resolution" | "maintain-framerate" | "balanced";
  scaleResolutionDownBy?: number;
};

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
  let state: MirrorState = {
    status: "idle",
    error: null,
    audio: false,
    lowFpsWarning: null,
  };
  let generation = 0;
  // Contador de operações assíncronas em andamento (setAudio/setQuality). Após cada await,
  // verificamos se a operação ainda é a mais recente; chamadas mais antigas são descartadas.
  let pendingOperation = 0;
  let pc: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  let audioSender: RTCRtpSender | null = null;
  let viewerPresent = false;
  let offered = false;
  let offering = false;
  // Um restart pedido durante outra oferta fica pendente; a epoch de restart não é gasta
  // até que a oferta realmente saia (ver offer()).
  let pendingRestart = false;
  // Orçamento do host: no máximo dois ICE restarts por episódio (MAX_ICE_RESTARTS).
  let iceRestarts = 0;
  let answered = false;
  let statsTimer: number | null = null;
  let lastSurfaceType: "screen" | "window" | null = null;
  // Qualidade de constraints da track aplicada com sucesso; usada para reverter se
  // setParameters falhar após applyConstraints já ter mudado a captura.
  let lastAppliedQuality: Quality = "1080p";
  // Decisão adaptativa pura: bitrate reage à rede, escala só reage à CPU (EX-001).
  let adaptive: AdaptiveState = initialAdaptiveState();
  // Uma troca manual de qualidade invalida degraus já enfileirados pelo timer: a fila serializa,
  // mas não cancela trabalho pendente. Cada reset incrementa a epoch.
  let adaptiveEpoch = 0;
  // Serializa setParameters do timer com o de setQuality: getParameters/setParameters não são
  // atômicos e uma intercalação poderia descartar um degrau de bitrate.
  let paramsChain: Promise<void> = Promise.resolve();
  let lastEncoderStats:
    | (RTCOutboundRtpStreamStats & {
        qualityLimitationReason?: string;
        framesEncoded?: number;
        totalEncodeTime?: number;
      })
    | null = null;

  // Aviso dinâmico de FPS baixo na captura de janela (Windows).
  // Só conta como "ativo" quando a janela está produzindo quadros (>= 8 fps), evitando
  // falso positivo em janela estática ou minimizada.
  const LOW_FPS_MIN_ACTIVE = 8; // abaixo disso, a janela está estática/minimizada
  const LOW_FPS_MAX = 23; // <= 23 fps enquanto produz quadros = lento
  const GOOD_FPS_MIN = 25; // >= 25 fps = recuperado
  const LOW_FPS_SAMPLES_TO_TRIGGER = 5; // ~5 s de amostras de 1 s
  const GOOD_FPS_SAMPLES_TO_CLEAR = 3; // 3 amostras seguidas boas

  let previousFramesEncoded: number | null = null;
  let previousTimestamp: number | null = null;
  let lowFpsConsecutive = 0;
  let goodFpsConsecutive = 0;
  let lowFpsWarningEmitted = false;

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

  /** Enfileira uma alteração de params sem deixar rejeição presa na cadeia. */
  function queueParams<T>(task: () => Promise<T>): Promise<T> {
    const next = paramsChain.then(task);
    paramsChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Reinicia a sessão de decisão; degraus enfileirados com a epoch antiga são descartados. */
  function resetAdaptive(): void {
    adaptiveEpoch += 1;
    adaptive = initialAdaptiveState();
  }

  function clearLowFpsWarning(): void {
    lowFpsWarningEmitted = false;
    lowFpsConsecutive = 0;
    goodFpsConsecutive = 0;
    emit({ lowFpsWarning: null });
  }

  /**
   * Avalia o FPS medido do sender de vídeo e dispara/limpa o aviso de captura de janela lenta.
   * Dispara apenas quando a janela está ativamente produzindo quadros (>= 8 fps e <= 23 fps)
   * por ~5 s consecutivas. Limpa quando o FPS sobe para >= 25 fps por 3 amostras seguidas.
   */
  function evaluateLowFpsWarning(fps: number): void {
    if (lastSurfaceType !== "window") {
      if (lowFpsWarningEmitted) clearLowFpsWarning();
      return;
    }
    if (fps >= GOOD_FPS_MIN) {
      goodFpsConsecutive += 1;
      lowFpsConsecutive = 0;
      if (lowFpsWarningEmitted && goodFpsConsecutive >= GOOD_FPS_SAMPLES_TO_CLEAR) {
        clearLowFpsWarning();
      }
    } else if (fps >= LOW_FPS_MIN_ACTIVE && fps <= LOW_FPS_MAX) {
      lowFpsConsecutive += 1;
      goodFpsConsecutive = 0;
      if (!lowFpsWarningEmitted && lowFpsConsecutive >= LOW_FPS_SAMPLES_TO_TRIGGER) {
        lowFpsWarningEmitted = true;
        emit({
          lowFpsWarning:
            "Window capture below 24 fps on Windows. Use Full Screen for stable 30 fps.",
        });
      }
    } else {
      // fps < LOW_FPS_MIN_ACTIVE: janela estática ou minimizada — não conta como ativo
      lowFpsConsecutive = 0;
      goodFpsConsecutive = 0;
    }
  }

  function release(): void {
    if (statsTimer !== null) {
      window.clearInterval(statsTimer);
      statsTimer = null;
    }
    lastSurfaceType = null;
    clearLowFpsWarning();
    for (const track of stream?.getTracks() ?? []) track.stop();
    audioSender = null;
    audioTrack = null;
    videoTrack = null;
    stream = null;
    pc?.close();
    pc = null;
    offered = false;
    offering = false;
    pendingRestart = false;
    iceRestarts = 0;
    answered = false;
    // Zera estado do encoder e contadores de FPS: uma sessão seguinte não deve herdar
    // medições da sessão anterior. pendingOperation também é invalidado para que um
    // setQuality em voo não reporte sucesso depois do stop.
    pendingOperation += 1;
    lastEncoderStats = null;
    resetAdaptive();
    lastAppliedQuality = "1080p";
    previousFramesEncoded = null;
    previousTimestamp = null;
    lowFpsConsecutive = 0;
    goodFpsConsecutive = 0;
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
   * Aplica o teto de bitrate e a escala ao sender de vídeo. `native` deixa a fonte em paz:
   * não injeta maxFramerate nem maxBitrate via setParameters.
   * Trata params.encodings vazio (antes da negociação SDP) injetando um encoding vazio.
   *
   * `scaleResolutionDownBy` é escrito no topo de params (o que o Chromium lê) **e** em
   * encodings[0] (o que a especificação define). Escrever só no topo com 1.0 fixo tornava a
   * válvula EX-001 inerte; escrever só em encodings[0] não afetava o encoder no Chromium.
   */
  async function applyVideoBitrateCap(
    sender: RTCRtpSender,
    maxBitrateBps: number,
    quality: Quality,
    scaleResolutionDownBy: EncoderScale = 1.0,
  ): Promise<void> {
    const params = sender.getParameters() as RtcSenderParams;
    if (!(params.encodings?.length)) {
      params.encodings = [{}];
    }
    const encoding = params.encodings[0]! as RtcEncodingParams;
    if (quality === "native") {
      // native não impõe teto: remove limites aplicados anteriormente (1080p/720p)
      encoding.maxBitrate = undefined;
      encoding.maxFramerate = undefined;
      delete encoding.scaleResolutionDownBy;
    } else {
      Object.assign(encoding, videoEncodingParams(maxBitrateBps, scaleResolutionDownBy));
      // degradationPreference pertence só ao nível de cima de params (o Chromium ignora o
      // campo dentro de encodings[0]); scaleResolutionDownBy precisa existir nos dois.
      delete encoding.degradationPreference;
    }
    params.degradationPreference = "maintain-resolution";
    params.scaleResolutionDownBy = quality === "native" ? 1.0 : scaleResolutionDownBy;
    await sender.setParameters(params);
  }

  async function offer(restart = false): Promise<OfferOutcome> {
    const peer = pc;
    if (peer === null) return "failed";
    if (offering || peer.signalingState !== "stable") {
      if (restart) pendingRestart = true;
      return "skipped";
    }
    if (!restart && (offered || answered)) return "skipped";

    offering = true;
    try {
      if (restart) peer.restartIce();
      const local = await peer.createOffer();
      await peer.setLocalDescription(local);
      if (peer !== pc) return "failed";
      offered = true;
      if (peer.localDescription !== null) {
        window.mirror.sendSignal({ type: "offer", sdp: peer.localDescription.sdp });
      }
      // Conta o orçamento somente quando o restart chegou à sinalização. Um pedido ignorado
      // enquanto outra oferta estava em voo não pode queimar uma das duas tentativas.
      if (restart) iceRestarts += 1;
      emit({ status: restart ? "reconnecting" : "waiting", error: null });
      return "sent";
    } catch (err) {
      if (peer === pc) fail(err instanceof Error ? err.message : String(err));
      return "failed";
    } finally {
      offering = false;
      if (pendingRestart && peer === pc && peer.signalingState === "stable") {
        pendingRestart = false;
        void offer(true);
      }
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
      // Guarda a captura imediatamente: qualquer falha posterior (applyConstraints,
      // peer, setParameters) chama release() e encerra todas as tracks já adquiridas.
      stream = capture;

      const video = capture.getVideoTracks()[0];
      if (video === undefined) throw new Error("display capture returned no video track");
      // "detail" instrui o Chromium a manter qualidade visual, não derrubar
      // resolução nem fps, quando o encoder estiver pressionado. Complementa o
      // teto de bitrate adaptativo (1,5–5 Mbps) sem reduzir a resolução por rede (opção b).
      video.contentHint = "detail";

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
      lastAppliedQuality = request.quality;

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
        // totalEncodeTime; remote-inbound-rtp expõe fractionLost (perda vista pelo receptor).
        // Nada disso trafega pela sinalização e nada disso é lido na Fire TV (o viewer não faz
        // getStats() fora de ?debug=1). O timer de 3 s alimenta a decisão pura `nextAdaptive`:
        // bitrate reage à rede, resolução só reage à CPU (EX-001).
        statsTimer = window.setInterval(async () => {
          try {
            if (run !== generation) return;
            const report = await videoSender.getStats();
            if (run !== generation) return;
            let reason: string | null = null;
            let fractionLost: number | null = null;
            report.forEach((entry) => {
              if (entry.type === "outbound-rtp" && entry.kind === "video") {
                const next = entry as RTCOutboundRtpStreamStats & {
                  qualityLimitationReason?: string;
                  framesEncoded?: number;
                  totalEncodeTime?: number;
                };
                lastEncoderStats = next;
                reason = next.qualityLimitationReason ?? null;
                const frames = next.framesEncoded ?? 0;
                const ts = typeof next.timestamp === "number" ? next.timestamp : null;
                if (
                  previousFramesEncoded !== null &&
                  previousTimestamp !== null &&
                  ts !== null
                ) {
                  const deltaFrames = frames - previousFramesEncoded;
                  const deltaSeconds = (ts - previousTimestamp) / 1000;
                  if (deltaSeconds > 0) {
                    evaluateLowFpsWarning(deltaFrames / deltaSeconds);
                  }
                }
                previousFramesEncoded = frames;
                previousTimestamp = ts;
              } else if (entry.type === "remote-inbound-rtp" && entry.kind === "video") {
                const inbound = entry as { fractionLost?: number };
                if (typeof inbound.fractionLost === "number") fractionLost = inbound.fractionLost;
              }
            });
            const epoch = adaptiveEpoch;
            const qualityAtSample = lastAppliedQuality;
            const decision = nextAdaptive(
              adaptive,
              { qualityLimitationReason: reason, fractionLost },
              qualityAtSample,
            );
            const apply = decision.apply;
            if (apply === null) {
              adaptive = decision.state;
              return;
            }
            // Só confirma a histerese se o encoder aceitou o degrau. Um setParameters que
            // rejeita não pode avançar o estado: o mesmo degrau deve ser tentado de novo.
            const applied = await queueParams(async () => {
              if (epoch !== adaptiveEpoch || run !== generation) return false;
              await applyVideoBitrateCap(
                videoSender,
                apply.maxBitrateBps,
                qualityAtSample,
                apply.scaleResolutionDownBy,
              );
              return true;
            });
            if (applied) adaptive = decision.state;
          } catch {
            // stats são best-effort; uma conexão fechada rejeita getStats()/setParameters()
          }
        }, 3000);
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
          iceRestarts = 0;
          pendingRestart = false;
          emit({ status: "live", error: null });
        }
        if (peer.connectionState === "failed") {
          // The host is the offerer: up to two ICE restarts per episode, then give up. The
          // viewer runs the same budget on its own failed state (MAX_ICE_RESTARTS).
          if (!canRestartIce(iceRestarts)) {
            fail("Peer connection failed");
            return;
          }
          void offer(true);
        }
      };
      // Um restart pedido durante uma negociação em andamento espera a sinalização estabilizar
      // em vez de gastar o orçamento sem enviar nada.
      peer.onsignalingstatechange = () => {
        if (peer !== pc || !pendingRestart || peer.signalingState !== "stable") return;
        pendingRestart = false;
        void offer(true);
      };

      pc = peer;
      videoTrack = video;
      audioTrack = audio;

      if (viewerPresent) {
        const outcome = await offer();
        if (run !== generation) return stopped();
        if (outcome === "failed") {
          return { ok: false, error: state.error ?? "could not send the offer" };
        }
      }

      lastAppliedQuality = request.quality;
      // Preserva qualquer aviso não-crítico (ex.: bitrate cap) em vez de apagá-lo com error: null.
      emit({ status: "waiting", error: state.error, audio: audio !== null });
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
    const operation = ++pendingOperation;
    const available = await window.mirror.setAudio(on);
    if (operation !== pendingOperation) return false;
    if (on && !available) return false;
    if (audioSender === null || audioTrack === null) return true;

    await audioSender.replaceTrack(on ? audioTrack : null);
    if (operation !== pendingOperation) return false;
    audioTrack.enabled = on;
    emit({ audio: on });
    return true;
  }

  async function setQuality(quality: Quality): Promise<boolean> {
    if (videoTrack === null) return true;
    const constraints = videoConstraints(quality);
    const previous = lastAppliedQuality;
    const operation = ++pendingOperation;
    const runAtCall = generation;
    try {
      // Empty constraints clear the cap; the capture may keep its current size until it changes.
      await videoTrack.applyConstraints(constraints ?? {});
      if (operation !== pendingOperation) return false;
      // Reaplica o teto na fila usada pelo timer e recomeça a histerese: uma troca manual de
      // qualidade é uma nova sessão de decisão (a válvula CPU volta no próximo sample).
      const videoSender = pc?.getSenders().find((sender) => sender.track === videoTrack);
      if (videoSender !== undefined) {
        try {
          const applied = await queueParams(async () => {
            if (operation !== pendingOperation || runAtCall !== generation) return false;
            await applyVideoBitrateCap(videoSender, TARGET_BITRATE_BPS, quality);
            return true;
          });
          if (!applied) return false;
        } catch (err) {
          // setParameters falhou após applyConstraints já ter mudado a track: reverta
          // as constraints para a qualidade anterior para que UI e captura não divirjam.
          await videoTrack.applyConstraints(videoConstraints(previous) ?? {}).catch(() => undefined);
          lastAppliedQuality = previous;
          resetAdaptive();
          const message = err instanceof Error ? err.message : String(err);
          emit({ error: `Could not change quality to ${quality}: ${message}` });
          return false;
        }
      }
      if (operation !== pendingOperation) return false;
      lastAppliedQuality = quality;
      resetAdaptive();
      emit({ error: null });
      if (quality === "720p") clearLowFpsWarning();
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

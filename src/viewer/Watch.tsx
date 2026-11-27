import { useCallback, useEffect, useRef, useState } from "react";

import { parseSignal } from "../shared/protocol.ts";
import { RTC_CONFIG } from "../shared/rtc.ts";
import {
  connectionReducer,
  failureEvent,
  initialConnection,
  MAX_ICE_RESTARTS,
  type ConnectionEvent,
  type ConnectionState,
} from "./connection.ts";

const RECONNECT_TIMEOUT_MS = 8000;
// Tempo máximo para a primeira oferta do host ou a primeira mídia negociada. Impede que o
// espectador fique indefinidamente em "Waiting for the host..." quando a negociação não avança.
const FIRST_MEDIA_TIMEOUT_MS = 10_000;
// Limite de candidatos ICE pendentes antes da oferta remota. Impede que um peer com token
// válido encha a memória da TV com ICE antes da primeira oferta.
const MAX_PENDING_ICE = 50;

type WatchProps = { token: string; debug: boolean; onEnded: (message: string) => void };

type DebugInfo = {
  codec: string;
  resolution: string;
  fps: number;
  kbps: number;
  lost: number;
  framesDecoded?: number;
  framesDropped?: number;
  freezeCount?: number;
  totalInterFrameDelay?: number;
  audio: number | null;
};

type InboundStats = RTCStats & {
  kind?: string;
  codecId?: string;
  bytesReceived?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  packetsLost?: number;
  framesDecoded?: number;
  framesDropped?: number;
  freezeCount?: number;
  totalInterFrameDelay?: number;
  audioLevel?: number;
};

export function Watch({ token, debug, onEnded }: WatchProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const muteRef = useRef<HTMLButtonElement>(null);
  const reconnectRef = useRef<HTMLButtonElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const finishRef = useRef<(message: string) => void>(() => undefined);
  const hideTimer = useRef<number | null>(null);
  const connectionRef = useRef<ConnectionState>(initialConnection);
  const needsSoundRef = useRef(false);
  const controlsRef = useRef(true);
  const [status, setStatus] = useState("Connecting...");
  const [hasStream, setHasStream] = useState(false);
  const [muted, setMuted] = useState(true);
  const [needsSound, setNeedsSound] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>(initialConnection);
  const [fullscreen, setFullscreen] = useState(false);
  const [controls, setControls] = useState(true);
  const [stats, setStats] = useState<DebugInfo | null>(null);

  const showControls = useCallback(() => {
    setControls(true);
    controlsRef.current = true;
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!needsSoundRef.current) {
        controlsRef.current = false;
        setControls(false);
      }
    }, 5000);
  }, []);

  useEffect(() => {
    needsSoundRef.current = needsSound;
  }, [needsSound]);

  useEffect(() => {
    if (!needsSound) return;
    setControls(true);
    controlsRef.current = true;
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    muteRef.current?.focus();
  }, [needsSound]);

  useEffect(() => {
    if (connection.phase === "lost") reconnectRef.current?.focus();
    else if (connection.phase === "connected" || connection.phase === "reconnecting") {
      muteRef.current?.focus();
    }
  }, [connection.phase]);

  useEffect(() => {
    showControls();
    const onPointer = () => showControls();
    window.addEventListener("pointermove", onPointer);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [showControls]);

  useEffect(() => {
    muteRef.current?.focus();
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    let disposed = false;
    let finished = false;
    let remoteReady = false;
    let statsTimer: number | null = null;
    let reconnectTimer: number | null = null;
    // Um restart concedido ainda não chegou a "checking": qualquer novo `failed` nesta janela
    // é duplicata do outro handler, não uma segunda queda.
    let restartPending = false;
    let firstMediaTimer: number | null = null;
    let previousVideo: { bytes: number; timestamp: number } | null = null;
    const pendingIce: RTCIceCandidateInit[] = [];
    // Serializa ofertas concorrentes: cada oferta espera a anterior terminar antes de
    // chamar setRemoteDescription / setLocalDescription. Isso evita interleaving quando
    // o host envia um reinício ICE seguido de outra oferta.
    let offerChain: Promise<void> = Promise.resolve();
    const video = videoRef.current;
    const peer = new RTCPeerConnection(RTC_CONFIG);
    const url = new URL("/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    const socket = new WebSocket(url.toString());
    socketRef.current = socket;

    function finish(message: string): void {
      if (finished) return;
      finished = true;
      if (statsTimer !== null) window.clearInterval(statsTimer);
      if (firstMediaTimer !== null) {
        window.clearTimeout(firstMediaTimer);
        firstMediaTimer = null;
      }
      clearRetry();
      socket.onclose = null;
      socket.close();
      peer.close();
      if (!disposed) onEnded(message);
    }
    finishRef.current = finish;

    function transition(event: ConnectionEvent): ConnectionState {
      const next = connectionReducer(connectionRef.current, event);
      connectionRef.current = next;
      if (!disposed) setConnection(next);
      return next;
    }

    /** Fecha a janela de retry: nenhum timeout ou flag sobrevive a um estado terminal. */
    function clearRetry(): void {
      restartPending = false;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function handleConnected(): void {
      if (finished || disposed) return;
      clearRetry();
      transition("connected");
      setStatus("Connected");
    }

    // Up to two ICE restarts per episode; the host offerer answers with the matching restarted
    // offer. A `failed` while a restart is still pending is the duplicate from the other state
    // handler, not a new drop — it must not spend the second restart. `checking` re-arms the gate.
    function handleFailure(): void {
      if (finished || disposed) return;
      const before = connectionRef.current;
      const next = transition(failureEvent(restartPending));
      if (next.phase !== "reconnecting" || next.restarts === before.restarts) {
        if (next.phase === "lost") clearRetry();
        return;
      }
      clearRetry();
      restartPending = true;
      try {
        peer.restartIce();
      } catch {
        transition("timeout");
        clearRetry();
        return;
      }
      setStatus(`Reconnecting... (${next.restarts}/${MAX_ICE_RESTARTS})`);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        restartPending = false;
        transition("timeout");
      }, RECONNECT_TIMEOUT_MS);
    }

    async function tryUnmute(): Promise<void> {
      if (video === null) return;
      video.muted = false;
      try {
        await video.play();
        if (video.paused || video.muted) throw new DOMException("blocked", "NotAllowedError");
        if (!disposed) {
          setMuted(false);
          setNeedsSound(false);
        }
      } catch {
        video.muted = true;
        void video.play().catch(() => undefined);
        if (!disposed) {
          setMuted(true);
          setNeedsSound(true);
        }
      }
    }

    async function acceptOffer(sdp: string): Promise<void> {
      // Cada oferta entra na fila serial; se uma oferta mais nova já começou, esta é descartada.
      const previous = offerChain;
      offerChain = (async () => {
        await previous;
        if (finished || disposed) return;
        try {
          await peer.setRemoteDescription({ type: "offer", sdp });
          if (finished || disposed) return;
          remoteReady = true;
          for (const candidate of pendingIce.splice(0)) {
            await peer.addIceCandidate(candidate).catch(() => undefined);
          }
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          if (peer.localDescription !== null && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "answer", sdp: peer.localDescription.sdp }));
            if (firstMediaTimer !== null) {
              window.clearTimeout(firstMediaTimer);
              firstMediaTimer = null;
            }
          }
        } catch {
          if (!finished && !disposed) finish("Could not start playback. Pair again.");
        }
      })();
      await offerChain;
    }

    peer.ontrack = (event) => {
      if (video === null || disposed) return;
      const [stream] = event.streams;
      if (stream === undefined) return;
      if (video.srcObject !== stream) video.srcObject = stream;
      if (firstMediaTimer !== null) {
        window.clearTimeout(firstMediaTimer);
        firstMediaTimer = null;
      }
      setHasStream(true);
      setStatus("Connected");
      void video.play().catch(() => setStatus("Press Sound to play."));
      void tryUnmute();
    };

    peer.onicecandidate = (event) => {
      if (event.candidate === null || socket.readyState !== WebSocket.OPEN) return;
      const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = event.candidate;
      socket.send(
        JSON.stringify({
          type: "ice",
          candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment },
        }),
      );
    };

    peer.oniceconnectionstatechange = () => {
      if (finished || disposed) return;
      if (peer.iceConnectionState === "checking") {
        restartPending = false;
        transition("checking");
      }
      if (peer.iceConnectionState === "failed") handleFailure();
      if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
        handleConnected();
      }
    };

    peer.onconnectionstatechange = () => {
      if (finished || disposed) return;
      if (peer.connectionState === "connected") handleConnected();
      if (
        peer.connectionState === "failed" &&
        peer.iceConnectionState !== "failed" &&
        peer.iceConnectionState !== "checking"
      ) {
        handleFailure();
      }
    };

    socket.onopen = () => {
      setStatus("Waiting for the host...");
      // Timeout de primeira oferta/primeira mídia: se o host não negociar a tempo, encerra e
      // deixa o usuário voltar ao PIN pad.
      firstMediaTimer = window.setTimeout(() => {
        firstMediaTimer = null;
        finish("No media from the host. Pair again.");
      }, FIRST_MEDIA_TIMEOUT_MS);
    };
    socket.onerror = () => finish("Connection lost. Pair again.");
    socket.onclose = () => {
      if (!disposed && !finished) finish("Connection lost. Pair again.");
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const signal = parseSignal(event.data);
      if (signal === null) return;
      if (signal.type === "offer") {
        void acceptOffer(signal.sdp);
      } else if (signal.type === "ice") {
        if (remoteReady) void peer.addIceCandidate(signal.candidate).catch(() => undefined);
        else {
          if (pendingIce.length >= MAX_PENDING_ICE) {
            finish("Too many ICE candidates before the offer. Pair again.");
            return;
          }
          pendingIce.push(signal.candidate);
        }
      } else if (signal.type === "stop") {
        finish("The host stopped sharing.");
      }
    };

    if (debug) {
      statsTimer = window.setInterval(() => {
        void (async () => {
          try {
            const report = await peer.getStats();
            const inbound: InboundStats[] = [];
            report.forEach((entry) => {
              if (entry.type === "inbound-rtp") inbound.push(entry as InboundStats);
            });
            const videoStats = inbound.find((entry) => entry.kind === "video");
            if (videoStats === undefined) return;
            const audioStats = inbound.find((entry) => entry.kind === "audio");
            const codec =
              videoStats.codecId === undefined
                ? undefined
                : (report.get(videoStats.codecId) as { mimeType?: string } | undefined);
            const bytes = videoStats.bytesReceived ?? 0;
            const timestamp = videoStats.timestamp;
            let kbps = 0;
            if (previousVideo !== null && timestamp > previousVideo.timestamp) {
              kbps = ((bytes - previousVideo.bytes) * 8) / (timestamp - previousVideo.timestamp);
            }
            previousVideo = { bytes, timestamp };
            if (!disposed) {
              setStats({
                codec: codec?.mimeType ?? "unknown",
                resolution: `${videoStats.frameWidth ?? 0}x${videoStats.frameHeight ?? 0}`,
                fps: Math.round(videoStats.framesPerSecond ?? 0),
                kbps: Math.round(kbps),
                lost: videoStats.packetsLost ?? 0,
                framesDecoded: videoStats.framesDecoded,
                framesDropped: videoStats.framesDropped,
                freezeCount: videoStats.freezeCount,
                totalInterFrameDelay: videoStats.totalInterFrameDelay,
                audio: typeof audioStats?.audioLevel === "number" ? audioStats.audioLevel : null,
              });
            }
          } catch {
            // stats are best-effort; a closed connection rejects getStats()
          }
        })();
      }, 1000);
    }

    return () => {
      disposed = true;
      finishRef.current = () => undefined;
      if (statsTimer !== null) window.clearInterval(statsTimer);
      if (firstMediaTimer !== null) window.clearTimeout(firstMediaTimer);
      clearRetry();
      socket.onclose = null;
      socket.close();
      peer.close();
      socketRef.current = null;
      if (video !== null) video.srcObject = null;
    };
  }, [token, debug, onEnded]);

  const toggleMute = useCallback(async (): Promise<void> => {
    const video = videoRef.current;
    if (video === null) return;
    if (!muted) {
      video.muted = true;
      setMuted(true);
      setNeedsSound(false);
      showControls();
      return;
    }
    video.muted = false;
    try {
      await video.play();
      if (video.paused || video.muted) throw new DOMException("blocked", "NotAllowedError");
      setMuted(false);
      setNeedsSound(false);
      showControls();
    } catch {
      video.muted = true;
      void video.play().catch(() => undefined);
      setMuted(true);
      setNeedsSound(true);
      showControls();
    }
  }, [muted, showControls]);

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement !== null) await document.exitFullscreen();
      else await shellRef.current?.requestFullscreen();
    } catch {
      // fullscreen is optional on browsers that refuse it
    }
  }

  // Enter is the D-pad activation key, so it only reveals hidden controls once; `m` and `f`
  // mirror the buttons without stealing a focused button's own activation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const hidden = !controlsRef.current;
      showControls();
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" && hidden) {
        event.preventDefault();
        return;
      }
      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        void toggleMute();
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMute, showControls]);

  function stopWatching(): void {
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "stop", reason: "viewer stopped" }));
    }
    finishRef.current("You stopped watching.");
  }

  return (
    <div className="watch" ref={shellRef} data-fullscreen={fullscreen} >
      <video ref={videoRef} className="watch-video" autoPlay playsInline muted={muted} />

      {!hasStream && (
        <p className="watch-message" role="status">
          {status}
        </p>
      )}

      {debug && (
        <pre className="watch-debug">
          {stats === null
            ? "waiting for media..."
            : `codec  ${stats.codec}
video  ${stats.resolution} @ ${stats.fps} fps
net    ${stats.kbps} kbps · ${stats.lost} lost${stats.framesDecoded !== undefined ? `\ndec  ${stats.framesDecoded} decoded · ${stats.framesDropped ?? 0} dropped · freeze ${stats.freezeCount ?? 0} · interFrameDelay ${stats.totalInterFrameDelay ?? 0}ms` : ""}
audio  ${stats.audio === null ? "n/a" : `${Math.round(stats.audio * 100)}%`}`}
        </pre>
      )}

      {connection.phase === "reconnecting" && (
        <div className="watch-reconnect" role="status">
          <p>
            Connection lost. Reconnecting... ({connection.restarts}/{MAX_ICE_RESTARTS})
          </p>
        </div>
      )}

      {connection.phase === "lost" && (
        <div className="watch-reconnect">
          <p role="alert">The connection was lost.</p>
          <button
            ref={reconnectRef}
            type="button"
            onClick={() => finishRef.current("Connection lost. Pair again.")}
          >
            Pair again
          </button>
        </div>
      )}

      <div className={controls ? "watch-controls" : "watch-controls is-hidden"}>
        <button
          ref={muteRef}
          className={needsSound ? "is-attention" : undefined}
          type="button"
          onClick={() => void toggleMute()}
        >
          {muted ? (needsSound ? "Press OK for sound" : "Sound") : "Mute"}
        </button>
        <button type="button" onClick={() => void toggleFullscreen()}>
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <button type="button" onClick={stopWatching}>
          Stop
        </button>
      </div>
    </div>
  );
}

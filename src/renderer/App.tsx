import { useEffect, useMemo, useRef, useState } from "react";

import type { HostState, Quality, SourceInfo } from "../shared/ipc.ts";
import { LiveStatus } from "./LiveStatus.tsx";
import { createMirror, type MirrorState } from "./mirror.ts";
import { PairPanel } from "./PairPanel.tsx";

const QUALITIES: Quality[] = ["native", "1080p", "720p"];
const DEFAULT_PORT = "4680";

function errorText(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : String(err);
}

function viewerLabel(userAgent: string): string {
  let device = "";
  if (/Silk|AFT/i.test(userAgent)) device = "Fire TV";
  else if (/Android/i.test(userAgent)) device = "Android";
  else if (/iPhone|iPad/i.test(userAgent)) device = "iOS";

  let browser = "browser";
  if (/Silk/i.test(userAgent)) browser = "Silk";
  else if (/Edg\//i.test(userAgent)) browser = "Edge";
  else if (/Firefox\//i.test(userAgent)) browser = "Firefox";
  else if (/Chrome\//i.test(userAgent)) browser = "Chrome";
  else if (/Safari\//i.test(userAgent)) browser = "Safari";

  return device === "" ? browser : `${device} · ${browser}`;
}

function portOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).port;
  } catch {
    return null;
  }
}

/** The real host window: pairing material, capture controls, live state and readable failures. */
export function App() {
  const mirror = useMemo(() => createMirror(), []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [host, setHost] = useState<HostState | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [quality, setQuality] = useState<Quality>("1080p");
  const [audioOn, setAudioOn] = useState(true);
  const [audioSupported, setAudioSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<MirrorState>({
    status: "idle",
    error: null,
    audio: false,
    lowFpsWarning: null,
    quality: "1080p",
    metrics: null,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [windowModeNotice, setWindowModeNotice] = useState<string | null>(null);
  const engineActive =
    state.status === "live" || state.status === "waiting" || state.status === "reconnecting";

  async function loadSources(): Promise<void> {
    setSourcesLoading(true);
    setSourceError(null);
    try {
      const list = await window.mirror.listSources();
      setSources(list);
      const preferred = list.find((entry) => entry.kind === "screen") ?? list[0];
      setSourceId((current) =>
        list.some((entry) => entry.id === current) ? current : (preferred?.id ?? ""),
      );
      if (list.length === 0) {
        setSourceError(
          "No screen or window was found. Check the screen-recording permission, then refresh.",
        );
      }
    } catch (err) {
      setSources([]);
      setSourceId("");
      setSourceError(`Could not list capture sources: ${errorText(err)}`);
    } finally {
      setSourcesLoading(false);
    }
  }

  useEffect(() => {
    window.mirror.onState(setHost);
    const offMirror = mirror.onChange(setState);
    window.mirror.onSignal((signal) => mirror.handleSignal(signal));
    void loadSources();
    void (async () => {
      try {
        const capabilities = await window.mirror.capabilities();
        setAudioSupported(capabilities.audio);
        if (!capabilities.audio) setAudioOn(false);
      } catch (err) {
        setAudioSupported(false);
        setNotice(`Could not read system audio support: ${errorText(err)}`);
      }
    })();
    return () => offMirror();
  }, [mirror]);

  useEffect(() => {
    if ((state.status === "idle" || state.status === "error") && videoRef.current !== null) {
      videoRef.current.srcObject = null;
    }
  }, [state.status]);

  async function start(): Promise<void> {
    setNotice(null);
    setWindowModeNotice(null);
    try {
      const result = await mirror.start({ sourceId, quality, audio: audioOn });
      if (!result.ok) return;
      if (videoRef.current !== null) videoRef.current.srcObject = result.stream;
      if (audioOn && !result.audio) {
        setAudioOn(false);
        setNotice("This system did not provide system audio. The video is streaming without it.");
      }
    } catch (err) {
      setNotice(`Could not start capture: ${errorText(err)}`);
    }
  }

  function stop(): void {
    setNotice(null);
    setWindowModeNotice(null);
    mirror.stop();
  }

  async function toggleAudio(on: boolean): Promise<void> {
    setNotice(null);
    if (!engineActive) {
      setAudioOn(on);
      return;
    }
    try {
      const changed = await mirror.setAudio(on);
      if (!changed) {
        setNotice("System audio was not captured at start. Stop and start again with audio enabled.");
        return;
      }
      setAudioOn(on);
    } catch (err) {
      setNotice(`Could not change system audio: ${errorText(err)}`);
    }
  }

  async function changeQuality(next: Quality): Promise<void> {
    setNotice(null);
    if (!engineActive) {
      setQuality(next);
      return;
    }
    const previous = quality;
    setQuality(next);
    try {
      const applied = await mirror.setQuality(next);
      if (!applied) {
        setQuality(previous);
        return;
      }
      // O aviso só se aplica a 1080p/native; ao mudar para 720p ele some.
      if (next === "720p") setWindowModeNotice(null);
    } catch (err) {
      setQuality(previous);
      setNotice(`Could not change quality: ${errorText(err)}`);
    }
  }

  const active = state.status === "starting" || engineActive;
  const audioChecked = engineActive ? state.audio : audioOn;
  const viewer = host?.viewer ?? null;
  const fallbackPort = portOf(host?.urls[0]);
  const portFallback =
    fallbackPort !== null && fallbackPort !== "" && fallbackPort !== DEFAULT_PORT
      ? fallbackPort
      : null;

  let statusText = "Ready.";
  if (state.status === "starting") statusText = "Starting capture...";
  else if (state.status === "waiting") {
    statusText =
      viewer === null ? "Capturing. Waiting for a viewer." : "Viewer connected. Negotiating...";
  } else if (state.status === "reconnecting") statusText = "Reconnecting to the viewer...";
  else if (state.status === "live") statusText = "Streaming to the viewer.";
  else if (state.status === "error") statusText = state.error ?? "Capture failed.";

  return (
    <main className="host">
      <header className="host-header">
        <div className="brand">
          <h1>Farol</h1>
          <p>Share your screen and system audio over your local Wi-Fi.</p>
        </div>
        <span className={viewer === null ? "viewer-pill" : "viewer-pill is-live"}>
          <span className="dot" />
          {viewer === null ? "Waiting for viewer" : `Viewer: ${viewerLabel(viewer.userAgent)}`}
        </span>
      </header>

      <div className="host-grid">
        <PairPanel state={host} />

        <section className="session" aria-label="Capture controls">
          <div className="source-row">
            <label className="field grow">
              <span>Source</span>
              <select
                value={sourceId}
                disabled={active || sourcesLoading}
                onChange={(event) => setSourceId(event.target.value)}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.kind === "screen" ? "Screen" : "Window"}: {source.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh sources"
              title="Refresh sources"
              onClick={() => void loadSources()}
              disabled={active || sourcesLoading}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M16.7 8A7 7 0 0 0 4.4 5.2L3 6.5M3 3.5v3h3M3.3 12A7 7 0 0 0 15.6 14.8l1.4-1.3m0 3v-3h-3" />
              </svg>
            </button>
          </div>

          <div className="config-row">
            <fieldset className="quality-field" disabled={state.status === "starting"}>
              <legend>Quality</legend>
              <div className="quality-options" role="group" aria-label="Quality">
                {QUALITIES.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className={quality === entry ? "quality-chip is-selected" : "quality-chip"}
                    aria-pressed={quality === entry}
                    onClick={() => void changeQuality(entry)}
                  >
                    {entry === "native" ? "Native" : entry}
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="audio-toggle">
              <span>System audio</span>
              <input
                type="checkbox"
                checked={audioChecked}
                disabled={audioSupported !== true || state.status === "starting"}
                onChange={(event) => void toggleAudio(event.target.checked)}
              />
              <span className="switch" aria-hidden="true" />
            </label>
          </div>

          <div className="actions">
            <button
              type="button"
              className={active ? "primary is-active" : "primary"}
              onClick={() => (active ? stop() : void start())}
              disabled={!active && (sourcesLoading || sourceId === "")}
            >
              {active ? "Stop Mirroring" : "Start Mirroring"}
            </button>
          </div>

          <div className="status-area" aria-label="Transmission status">
            <p className={state.status === "error" ? "status is-error" : "status"} role="status">
              {statusText}
            </p>
            <LiveStatus
              status={state.status}
              quality={state.quality}
              audio={state.audio}
              metrics={state.metrics}
            />
            {host?.error !== null && host?.error !== undefined && (
              <p className="message is-error" role="alert">{host.error}</p>
            )}
            {state.error !== null && state.status !== "error" && (
              <p className="message is-error" role="alert">{state.error}</p>
            )}
            {portFallback !== null && (
              <p className="message is-notice" role="status">
                Port {DEFAULT_PORT} was busy, so the viewer uses port {portFallback}. Use the address in the pairing card.
              </p>
            )}
            {sourcesLoading && <p className="muted">Loading capture sources...</p>}
            {sourceError !== null && <p className="message is-error" role="alert">{sourceError}</p>}
            {notice !== null && <p className="message is-notice" role="status">{notice}</p>}
            {windowModeNotice !== null && <p className="message is-notice" role="status">{windowModeNotice}</p>}
            {state.lowFpsWarning !== null && <p className="message is-notice" role="status">{state.lowFpsWarning}</p>}
            {audioSupported === null && <p className="muted">Checking system audio support...</p>}
            {audioSupported === false && <p className="muted">System audio is unavailable on this OS. Video only.</p>}
            {audioSupported === true && audioChecked && (
              <p className="muted">The viewer hears all system audio, not one app.</p>
            )}
          </div>

          <video
            ref={videoRef}
            className="preview"
            hidden={state.status !== "live"}
            autoPlay
            playsInline
            muted
          />
          {state.status !== "live" && (
            <div className="preview-placeholder" aria-live="polite">
              <svg viewBox="0 0 48 48" aria-hidden="true">
                <rect x="5" y="8" width="38" height="27" rx="3" />
                <path d="M17 41h14M24 35v6" />
              </svg>
              <span>Preview will appear when mirroring starts.</span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

import { useEffect, useRef, useState } from "react";

import type { HostState } from "../shared/ipc.ts";

/** Pairing material owned by main; this only displays it and runs the local countdown. */
export function PairPanel({ state }: { state: HostState | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // Mantém o último QR data URL recebido; quando o main envia null (não mudou), reusa o anterior.
  const qrRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const pin = state?.pin ?? "";
  const urls = state?.urls ?? [];
  const mdnsUrl = state?.mdnsUrl ?? null;
  const expiresAt = state?.expiresAt ?? 0;
  const seconds =
    pin === "" || expiresAt === 0 ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = pin !== "" && seconds === 0;
  const qrDataUrl = state?.qrDataUrl ?? qrRef.current;
  if (state?.qrDataUrl != null) qrRef.current = state.qrDataUrl;

  async function copyUrl(url: string): Promise<void> {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => setCopiedUrl((current) => (current === url ? null : current)), 1800);
    } catch {
      setCopiedUrl(null);
      setCopyError("Could not copy the address. Select and copy it manually.");
    }
  }

  return (
    <section className="pair-panel" aria-label="Viewer pairing">
      <div className="pin-block">
        <span className="eyebrow">Viewer PIN</span>
        <strong className="pin-digits">{pin === "" ? "------" : pin}</strong>
        <span className={expired ? "countdown is-expired" : "countdown"} aria-live="polite">
          {pin === ""
            ? "Starting the host service..."
            : expired
              ? "Refreshing PIN..."
              : `New PIN in ${seconds}s`}
        </span>
      </div>

      <div className="qr-block">
        {qrDataUrl ? (
          <img
            className="qr-image"
            src={qrDataUrl}
            alt="QR code for the viewer URL"
            width={320}
            height={320}
          />
        ) : (
          <div className="qr-image qr-placeholder">
            QR code
            <br />
            unavailable
          </div>
        )}
        <span className="hint">Scan to open the viewer with the PIN filled in.</span>
      </div>

      <div className="url-block">
        <span className="eyebrow">{urls.length > 1 ? "Viewer addresses" : "Viewer address"}</span>
        {urls.length === 0 ? (
          <p className="muted">Waiting for a LAN address...</p>
        ) : (
          <>
            {mdnsUrl !== null && (
              <div className="url-row" key={mdnsUrl}>
                <code className="url">{mdnsUrl}</code>
                <button className="copy-button" type="button" onClick={() => void copyUrl(mdnsUrl)}>
                  {copiedUrl === mdnsUrl ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            {urls.map((url) => (
              <div className="url-row" key={url}>
                <code className="url">{url}</code>
                <button className="copy-button" type="button" onClick={() => void copyUrl(url)}>
                  {copiedUrl === url ? "Copied" : "Copy"}
                </button>
              </div>
            ))}
          </>
        )}
        {copyError !== null && <span className="copy-feedback is-error" role="status">{copyError}</span>}
        {copiedUrl !== null && <span className="copy-feedback" role="status">Address copied.</span>}
        {mdnsUrl !== null && (
          <span className="hint">The name follows this PC's IP - nothing to type again after a router change.</span>
        )}
        {urls.length > 1 && <span className="hint">The QR uses the first IP address.</span>}
        {state?.viewer !== null && state?.viewer !== undefined && (
          <span className="hint">A viewer is connected. Pairing is paused until it leaves.</span>
        )}
      </div>
    </section>
  );
}

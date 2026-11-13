# Constraints

Last reviewed: 2026-11-13 by implementation agent

## Floor (always enforced, no setup required)

- No new suppression comments: `@ts-ignore`, `eslint-disable`, `# noqa`, `# type: ignore`
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}`
- No skipped or deleted tests without a reason in the commit message
- No secrets in source
- This file does not get weakened to make a change pass

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Types | Zero type errors | `npx tsc -p tsconfig.json` | every edit |
| Lint | Zero warnings/errors | `npm run lint` (`eslint . --max-warnings 0`) | every edit |
| Coverage | Project coverage ≥ 95.88% (ratchet from today) | `npm run coverage` | task end |
| Security: code | No STUN/TURN servers; viewer receive-only | `npm run check:gates` | task end |
| Security: architecture | `RTC_CONFIG.iceServers` empty & frozen; viewer has no capture APIs; host on `file://`; `/ws` relays `Signal` frames verbatim, never parses SDP | `npm run check:gates` | task end |
| `npm run verify` | All checks green: lint + test + coverage + build + gates | `npm run verify` | before commit |

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Project coverage | 95.88% | must not fall |
| (Performance budgets) | not yet measured | Lighthouse needs a running URL (Fire TV / preview) |
| (Accessibility) | not yet measured | needs WCAG rules written first |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|----|------|------|--------|-------|---------|
| (none) | — | — | — | — | — |

## Architecture boundaries (non-negotiable, from AGENTS.md / SPEC.md)

- **Viewer is receive-only:** no `getUserMedia`, `getDisplayMedia`, `navigator.mediaDevices`, or any media feature test in `src/viewer` or `dist/viewer`. Enforced by `check:gates`.
- **No STUN/TURN, ever:** `RTC_CONFIG.iceServers` stays empty and frozen in `src/` and `dist/`. Enforced by `check:gates`.
- **Host page on `file://`:** never served by the HTTP server; PIN/QR material stays on the host window.
- **Signaling verbatim:** `/ws` relays `Signal` frames verbatim and never parses SDP.
- **CSP strict:** every served response carries strict CSP; no inline `<script>`/`<style>`.
- **PIN pad is buttons:** never an `<input>` (Silk on-screen keyboard breaks the remote-only flow).
- **Resolution never reduced as an escape valve:** approach (b) — keep 1080p, accept frame drops when the LAN oscillates.

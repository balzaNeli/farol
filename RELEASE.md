# Farol — Release Notes

## What is Farol?

Farol is a **LAN-only screen + system audio mirroring** app. A host computer (Electron) captures its
screen and system audio and sends them over WebRTC to a viewer running in a browser on the same
Wi-Fi network. Nothing leaves the LAN — no STUN, no TURN, no cloud, no account, no app install on
the viewer.

The primary viewer target is an **Amazon Fire TV running Silk** with a D-pad remote. Phones and
tablets are supported as secondary targets.

## What's new in this release

This is a **pre-release** build. All core features are implemented and tested:

- **LAN server** — static serving, `/api/info`, `POST /api/pair`, WebSocket signaling relay
- **Pairing** — 6-digit PIN, 60 s TTL, rotation, 3-strike lockout, single-use tokens
- **Electron host shell** — window, permissions, IPC, host socket
- **Host capture** — `getDisplayMedia`, H.264 preferred, live quality/audio toggles
- **Viewer UI** — D-pad PIN pad, receive-only `<video>`, mute/fullscreen/stop controls, `?debug=1`
- **Security** — CSP headers on every route, empty `iceServers`, receive-only viewer, host UI on
  `file://` (never served over LAN)

## Downloads

| File | Description |
|---|---|
| `Farol Setup 0.1.0.exe` | Windows NSIS installer (x64) |
| `Farol Setup 0.1.0.exe.blockmap` | Block map for the installer |

## Quick start

```bash
# On the host PC
npm install
npm run build
npm start
```

The host window shows a URL, a QR code, and a 6-digit PIN. On the Fire TV, open Silk, go to the
URL, bookmark it, then enter the PIN. The QR code is for phones/tablets.

## Requirements

- **Node.js 24+** (for development)
- **Windows** for system audio (loopback). macOS and Linux run video-only.
- A **LAN** where devices can reach each other (no guest network, no AP/client isolation).
- An **Amazon Fire TV with Silk** for the primary viewer experience.

## Privacy and security

- No STUN, no TURN, no cloud. Peer-to-peer only on the LAN.
- Host window is `file://`, never served over the LAN (it shows the PIN).
- Viewer is receive-only: no `getUserMedia`/`getDisplayMedia`, no camera/mic permissions.
- One viewer at a time.
- PIN: 6 digits, 60 s TTL, rotates on success/failure, then 60 s lockout.

## Known limits

- The Fire TV must never encode — it only decodes and displays.
- System audio is Windows-only (whole-system mix, not per-app).
- Maximum one viewer at a time.
- No microphone capture, file transfer, whiteboard, multi-viewer, or internet traversal (v1).

## Full documentation

See [`README.md`](README.md) and [`README-EN.md`](README-EN.md) for the complete user guide,
troubleshooting, and contributing instructions. Hardware test results are in `docs/manual-tests.md`.

## License

MIT — see [LICENSE](LICENSE).

/**
 * The `farol.local` mDNS responder: a `node:dgram` UDP socket on the multicast group that
 * answers A/AAAA queries for one hostname (see `src/shared/mdns.ts` for the packet logic).
 *
 * Best-effort by contract: if the port is taken (Windows' own mDNS responder binds 5353
 * exclusively), the firewall blocks UDP, or no multicast interface can be joined, this warns
 * once and reports `active: false` — it never throws at the caller, and the LAN server keeps
 * working by direct IP. The socket is closed cleanly by `close()`, which first sends a TTL-0
 * goodbye so LAN caches drop the name immediately instead of at TTL expiry.
 */
import { createSocket, type RemoteInfo } from "node:dgram";

import {
  MDNS_GROUP,
  MDNS_PORT,
  TYPE_A,
  buildResponse,
  mdnsReply,
} from "../shared/mdns.ts";
import { rankedLanAddresses } from "./lan.ts";

export type MdnsResponderOptions = {
  hostname: string;
  /** Resolved fresh for every query, so a router-side IP change is answered without a restart. */
  getAddress: () => string | null;
  /** Default 5353 (tests bind an ephemeral one). */
  port?: number;
  /** Default "0.0.0.0". */
  address?: string;
  /** Join the multicast group and answer on it; false keeps the socket unicast-only (tests). */
  multicast?: boolean;
  /** Default: console.warn with a `[farol mdns]` prefix. */
  warn?: (message: string) => void;
};

export type MdnsResponder = {
  /** False when the socket could not bind or no multicast interface could be joined. */
  readonly active: boolean;
  /** The bound UDP port (the requested one when binding failed). */
  readonly port: number;
  /** Resolves once the goodbye is sent and the socket is closed; never hangs, never throws. */
  close: () => Promise<void>;
};

export async function startMdnsResponder(
  options: MdnsResponderOptions,
): Promise<MdnsResponder> {
  const warn =
    options.warn ??
    ((message: string) => console.warn(`[farol mdns] ${message}`));
  const port = options.port ?? MDNS_PORT;
  const address = options.address ?? "0.0.0.0";
  const multicast = options.multicast !== false;

  const socket = createSocket({ type: "udp4", reuseAddr: true });
  let active = false;
  let stopped = false;

  const stopSocket = (afterClose?: () => void): void => {
    if (stopped) {
      afterClose?.();
      return;
    }
    stopped = true;
    try {
      socket.close(() => afterClose?.());
    } catch (err) {
      warn(`could not close the mDNS socket: ${err instanceof Error ? err.message : String(err)}`);
      afterClose?.();
    }
  };

  socket.on("message", (buf: Buffer, rinfo: RemoteInfo) => {
    if (stopped || !active) return;
    const reply = mdnsReply(buf, {
      hostname: options.hostname,
      address: options.getAddress(),
      sourcePort: rinfo.port,
    });
    if (reply === null) return;
    const destination = reply.toSource
      ? { port: rinfo.port, address: rinfo.address }
      : { port: MDNS_PORT, address: MDNS_GROUP };
    socket.send(reply.packet, destination.port, destination.address, (err) => {
      if (err !== null) warn(`could not send an mDNS reply: ${err.message}`);
    });
  });

  socket.on("error", (err) => {
    if (stopped) return;
    active = false;
    warn(`mDNS responder stopped: ${err.message}`);
    stopSocket();
  });

  const outcome = await new Promise<{ ok: boolean; port: number }>((resolve) => {
    const fail = (err: Error): void => {
      warn(`could not bind UDP ${address}:${port}: ${err.message}`);
      resolve({ ok: false, port });
    };
    socket.once("error", fail);
    socket.bind(port, address, () => {
      socket.removeListener("error", fail);
      resolve({ ok: true, port: socket.address().port });
    });
  });

  /** A socket that broke after startup goes best-effort off with one warning, never a throw. */
  const onLateError = (err: Error): void => {
    if (stopped) return;
    active = false;
    warn(`mDNS responder stopped: ${err.message}`);
    stopSocket();
  };

  if (outcome.ok) {
    if (multicast) {
      const joinErrors: string[] = [];
      let joined = 0;
      const tryJoin = (localAddress?: string): void => {
        try {
          socket.addMembership(MDNS_GROUP, localAddress);
          joined += 1;
        } catch (err) {
          joinErrors.push(err instanceof Error ? err.message : String(err));
        }
      };
      // One membership per physical interface (Wi-Fi first), so both Wi-Fi and Ethernet
      // setups hear queries; without any, fall back to the system default interface.
      const interfaces = rankedLanAddresses().filter((entry) => entry.score >= 0);
      if (interfaces.length === 0) tryJoin();
      else for (const entry of interfaces) tryJoin(entry.address);

      try {
        // RFC 6762 section 11: multicast TTL 255 flags packets that leaked past the LAN scope.
        socket.setMulticastTTL(255);
      } catch (err) {
        warn(`could not set the multicast TTL: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (joined === 0) {
        warn(`no multicast membership could be joined: ${joinErrors.join("; ")}`);
        stopSocket();
      } else {
        active = true;
        socket.on("error", onLateError);
      }
    } else {
      // Unicast-only mode (tests): nothing else to set up.
      active = true;
      socket.on("error", onLateError);
    }
  } else {
    stopSocket();
  }

  return {
    get active() {
      return active;
    },
    port: outcome.port,
    close: () =>
      new Promise<void>((resolve) => {
        const finish = (): void => resolve();
        if (stopped) {
          finish();
          return;
        }
        if (!active || !multicast) {
          active = false;
          stopSocket(finish);
          return;
        }
        // Goodbye first (TTL 0), then close: caches drop the name instead of holding it 120 s.
        const goodbye = buildResponse({
          id: 0,
          question: { name: options.hostname, type: TYPE_A, qu: false },
          address: options.getAddress(),
          ttl: 0,
        });
        if (goodbye === null) {
          active = false;
          stopSocket(finish);
          return;
        }
        active = false;
        socket.send(goodbye, MDNS_PORT, MDNS_GROUP, () => stopSocket(finish));
      }),
  };
}

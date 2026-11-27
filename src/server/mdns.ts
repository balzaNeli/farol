/**
 * The `farol.local` mDNS responder: a `node:dgram` UDP socket on the multicast group that
 * answers A/AAAA queries for one hostname (see `src/shared/mdns.ts` for the packet logic).
 *
 * Best-effort by contract: if the port is taken (Windows' own mDNS responder binds 5353
 * exclusively), the firewall blocks UDP, or no multicast interface can be joined, this warns
 * once and reports `active: false` — it never throws at the caller, and the LAN server keeps
 * working by direct IP. The socket is closed cleanly by `close()`, which first sends a TTL-0
 * goodbye so LAN caches drop the name immediately instead of at TTL expiry.
 *
 * RFC 6762 section 8.4: when the host's address changes, the address record MUST be re-announced
 * — twice, about a second apart (section 8.3) — so caches flush the old address instead of
 * serving it for the rest of the TTL. A short poll samples `getAddress()`, because nothing
 * tells the process that the router handed out a new IP.
 */
import { createSocket, type RemoteInfo } from "node:dgram";

import {
  ANSWER_TTL,
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
  /** Default 5000 ms: how often the responder looks for an address change. */
  changePollMs?: number;
  /** Default 1000 ms: the gap between the two re-announcements (RFC 6762 section 8.3). */
  announceGapMs?: number;
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

const DEFAULT_CHANGE_POLL_MS = 5000;
const DEFAULT_ANNOUNCE_GAP_MS = 1000;

export async function startMdnsResponder(
  options: MdnsResponderOptions,
): Promise<MdnsResponder> {
  const warn = options.warn ?? ((message: string) => console.warn(`[farol mdns] ${message}`));
  const port = options.port ?? MDNS_PORT;
  const address = options.address ?? "0.0.0.0";
  const multicast = options.multicast !== false;
  const changePollMs = options.changePollMs ?? DEFAULT_CHANGE_POLL_MS;
  const announceGapMs = options.announceGapMs ?? DEFAULT_ANNOUNCE_GAP_MS;

  const socket = createSocket({ type: "udp4", reuseAddr: true });
  let active = false;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let announceTimer: NodeJS.Timeout | null = null;

  const stopTimers = (): void => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (announceTimer !== null) {
      clearTimeout(announceTimer);
      announceTimer = null;
    }
  };

  const stopSocket = (afterClose?: () => void): void => {
    stopTimers();
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

  /**
   * One unsolicited multicast announcement (or the goodbye at TTL 0): multicast format, id 0,
   * no question (RFC 6762 section 6), cache-flush so caches replace the record they hold.
   * A null address announces nothing — an empty record would only waste the wire.
   */
  const announce = (recordAddress: string | null, ttl: number, done?: () => void): void => {
    if (stopped || recordAddress === null) {
      done?.();
      return;
    }
    const packet = buildResponse({
      id: 0,
      question: { name: options.hostname, type: TYPE_A, qu: false },
      address: recordAddress,
      ttl,
      flush: true,
      echoQuestion: false,
    });
    if (packet === null) {
      done?.();
      return;
    }
    socket.send(packet, MDNS_PORT, MDNS_GROUP, (err) => {
      if (err !== null) warn(`could not send an mDNS announcement: ${err.message}`);
      done?.();
    });
  };

  /** RFC 6762 section 8.3: announce at least twice, one second apart. */
  const announceTwice = (recordAddress: string): void => {
    announce(recordAddress, ANSWER_TTL);
    announceTimer = setTimeout(() => {
      announceTimer = null;
      announce(recordAddress, ANSWER_TTL);
    }, announceGapMs);
    announceTimer.unref();
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
      try {
        // Deliver our own announcements to local members too: the observer in the tests relies
        // on it, and Node does not guarantee which way the OS default goes.
        socket.setMulticastLoopback(true);
      } catch (err) {
        warn(`could not enable multicast loopback: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (joined === 0) {
        warn(`no multicast membership could be joined: ${joinErrors.join("; ")}`);
        stopSocket();
      } else {
        active = true;
        socket.on("error", onLateError);

        // The address at boot is the baseline: the poll announces only real changes.
        let lastAnnounced = options.getAddress();
        pollTimer = setInterval(() => {
          if (stopped || !active) return;
          const current = options.getAddress();
          if (current === null || current === lastAnnounced) return;
          lastAnnounced = current;
          announceTwice(current);
        }, changePollMs);
        pollTimer.unref();
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
        active = false;
        // Goodbye first (TTL 0), then close: caches drop the name instead of holding it 120 s.
        // announce() skips the packet entirely when there is no address to say goodbye with.
        announce(options.getAddress(), 0, () => stopSocket(finish));
      }),
  };
}

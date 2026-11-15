import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Maps client IP → { failures, firstAt } for exponential backoff. */
type IpFailure = { failures: number; firstAt: number };

/**
 * Pairing store. Pure and injectable (clock only), so tests need no timers and the host UI can
 * poll `status()` for a countdown. Nothing here logs and nothing here serialises the PIN — what
 * may leave the process is the HTTP layer's decision, and it is always "not the PIN".
 *
 * Spec rules: 6-digit PIN, TTL 60 s, rotation on expiry and on the 3rd failure followed by a
 * 60 s lockout, one viewer at a time, single-use tokens bound to a session id.
 * Upgrade: per-IP exponential backoff. When a client IP accumulates failures, it gets its own
 * lockout timer (starting at lockoutMs, doubling up to a cap). The global lockout remains as a
 * backstop; per-IP lockouts are independent and cleared when the global lockout resolves.
 */

export type PairingResult =
  | { kind: "paired"; token: string; sessionId: string }
  | { kind: "invalid_pin"; attemptsLeft: number }
  | { kind: "expired" }
  | { kind: "locked"; retryAfterMs: number }
  | { kind: "busy" };

export type ViewerSession = { id: string; connected: boolean };

export type PairingStatus = {
  pin: string;
  expiresAtMs: number;
  lockedUntilMs: number;
  /** Tempo restante de lockout em ms, ou 0 quando não há lockout ativo. */
  retryAfterMs: number;
  viewer: ViewerSession | null;
};

export type PairingOptions = {
  now?: () => number;
  pinTtlMs?: number;
  lockoutMs?: number;
  /** A viewer that never connects must not hold the only seat forever. */
  connectTtlMs?: number;
  maxFailures?: number;
};

export type Pairing = {
  status: () => PairingStatus;
  verify: (pin: unknown, clientIp?: string) => PairingResult;
  consume: (token: unknown) => string | null;
  revoke: (sessionId: string) => void;
};

const PIN_SPACE = 1_000_000;

/** Compares two secrets without an early exit. Both are fixed-length by construction. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createPairing(options: PairingOptions = {}): Pairing {
  const now = options.now ?? Date.now;
  const pinTtlMs = options.pinTtlMs ?? 60_000;
  const lockoutMs = options.lockoutMs ?? 60_000;
  const connectTtlMs = options.connectTtlMs ?? 30_000;
  const maxFailures = options.maxFailures ?? 3;

  let pin = newPin();
  let expiresAtMs = now() + pinTtlMs;
  let lockedUntilMs = 0;
  let failures = 0;
  let session: (ViewerSession & { token: string; connectByMs: number }) | null = null;
  const ipFailures = new Map<string, IpFailure>();

  function newPin(): string {
    return String(randomInt(0, PIN_SPACE)).padStart(6, "0");
  }

  function rotate(at: number): void {
    pin = newPin();
    expiresAtMs = at + pinTtlMs;
  }

  /** Drops expired state so every public call sees the same, current world. */
  function sweep(): number {
    const at = now();
    // Global lockout expiry
    if (lockedUntilMs !== 0 && at >= lockedUntilMs) {
      lockedUntilMs = 0;
      failures = 0;
      // Limpa entradas de IP quando o lockout global se resolve (per SPEC)
      ipFailures.clear();
    }
    // Clean any session that past its connect deadline without connecting
    if (session !== null && !session.connected && at >= session.connectByMs) session = null;
    return at;
  }

  function status(): PairingStatus {
    const at = sweep();
    if (at >= expiresAtMs) rotate(at);
    return {
      pin,
      expiresAtMs,
      lockedUntilMs,
      retryAfterMs: lockedUntilMs !== 0 ? Math.max(0, lockedUntilMs - at) : 0,
      viewer: session === null ? null : { id: session.id, connected: session.connected },
    };
  }

  function resetIpFailure(ip: string): void {
    ipFailures.delete(ip);
  }

  function recordIpFailure(ip: string): void {
    const entry = ipFailures.get(ip) ?? { failures: 0, firstAt: now() };
    entry.failures += 1;
    if (entry.firstAt === 0) entry.firstAt = now();
    ipFailures.set(ip, entry);
  }

  function verify(input: unknown, clientIp?: string): PairingResult {
    const at = sweep();

    // 1) Check per-IP lockout first (independent of global state).
    // O backoff exponencial começa em lockoutMs e dobra a cada novo lockout do mesmo IP.
    if (clientIp !== undefined) {
      const ipEntry = ipFailures.get(clientIp);
      if (ipEntry && ipEntry.failures >= maxFailures) {
        const backoff = Math.min(
          lockoutMs * 2 ** (ipEntry.failures - maxFailures + 1),
          lockoutMs * 5,
        );
        const lockoutUntil = ipEntry.firstAt + backoff;
        if (at < lockoutUntil) {
          return { kind: "locked", retryAfterMs: lockoutUntil - at };
        }
        // Lockout por IP expirou: limpa a entrada para o próximo ciclo
        ipFailures.delete(clientIp);
      }
    }

    // 2) Global lockout check (backstop de 3 tentativas → 60 s).
    if (lockedUntilMs !== 0) return { kind: "locked", retryAfterMs: lockedUntilMs - at };

    if (session !== null) return { kind: "busy" };

    if (at >= expiresAtMs) {
      rotate(at);
      return { kind: "expired" };
    }
    if (typeof input === "string" && sameSecret(input, pin)) {
      const created = {
        id: randomBytes(8).toString("hex"),
        token: randomBytes(32).toString("hex"),
        connectByMs: at + connectTtlMs,
        connected: false,
      };
      session = created;
      // Reset per-IP failure count on successful PIN
      if (clientIp !== undefined) resetIpFailure(clientIp);
      failures = 0;
      rotate(at); // this code has done its job; the next viewer gets a fresh one
      return { kind: "paired", token: created.token, sessionId: created.id };
    }
    // Record failure per IP (apenas rastreia; o lockout é tratado acima e pelo global)
    if (clientIp !== undefined) {
      recordIpFailure(clientIp);
    }
    failures += 1;
    if (failures >= maxFailures) {
      lockedUntilMs = now() + lockoutMs;
      failures = 0;
      rotate(at);
      return { kind: "locked", retryAfterMs: lockoutMs };
    }
    return { kind: "invalid_pin", attemptsLeft: maxFailures - failures };
  }

  function consume(token: unknown): string | null {
    const at = sweep();
    if (session === null || session.connected || at >= session.connectByMs) return null;
    if (typeof token !== "string" || !sameSecret(token, session.token)) return null;
    session.connected = true;
    return session.id;
  }

  function revoke(sessionId: string): void {
    if (session !== null && session.id === sessionId) session = null;
  }

  return { status, verify, consume, revoke };
}
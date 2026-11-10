import { networkInterfaces } from "node:os";

type InterfaceEntry = { address: string; family: string; internal: boolean };
export type InterfaceMap = Record<string, InterfaceEntry[] | undefined>;

/** Pure ranking helpers — no new runtime deps. */
const isWiFiLike = (name: string): boolean =>
  /wi-fi|wireless|wlan|wlp/.test(name.toLowerCase());

const isEthernetLike = (name: string): boolean =>
  /eth|en[0-9]/.test(name.toLowerCase());

const isVirtualLike = (name: string): boolean => {
  const lower = name.toLowerCase();
  return (
    /v ethernet|docker|veth|virbr|vmnet|vboxnet|awdl|bridge[0-9]/.test(lower) ||
    /00:15:5d|00:05:69|00:0c:29|00:50:56|00:1c:42|00:16:3e|08:00:27|0a:00:27|52:54:00/.test(
      lower
    )
  );
};

// score: higher = preferred for the QR/primary URL
const rankScore = (name: string): number => {
  if (isWiFiLike(name)) return 100;
  if (isEthernetLike(name)) return 80;
  if (isVirtualLike(name)) return -200;
  return 0;
};

/**
 * Ranked list: physical interfaces first (Wi‑Fi > Ethernet),
 * virtual interfaces last. Keeps the full sorted list in `lanAddresses()`
 * so the UI can still show every address; the QR uses the top‑ranked one.
 */
export function rankedLanAddresses(interfaces: InterfaceMap = networkInterfaces()): { address: string; score: number; reason: string }[] {
  const found = new Map<string, { score: number; reason: string }>();
  for (const entries of Object.values(interfaces ?? [])) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      const score = rankScore(entry.address);
      if (!found.has(entry.address) || score > found.get(entry.address)!.score) {
        const reason: string =
          score >= 100 ? "Wi‑Fi" : score >= 80 ? "Ethernet" : score >= 0 ? "outra física" : "virtual";
        found.set(entry.address, { score, reason });
      }
    }
  }
  return [...found.entries()].map(([address, { score, reason }]) => ({ address, score, reason })).sort(
    (a, b) => b.score - a.score
  );
}

/**
 * Returns the single best address for the QR/primary URL, or null when no
 * physical interface is available (the host may still have virtual-only setups).
 */
export function preferredLanAddress(interfaces: InterfaceMap = networkInterfaces()): string | null {
  const ranked: Array<{ address: string; score: number; reason: string }> = rankedLanAddresses(interfaces) ?? [];
  if (ranked.length === 0) return null;
  // ranked.length > 0 guarantees ranked[0] exists
  return (ranked[0] as { address: string }).address;
}

/**
 * The addresses the host window offers to a viewer: non-internal, non-link-local IPv4s, sorted
 * and deduped so the list does not jump around when an adapter wakes up.
 * Keeps the full sorted list for UI/manual selection; use `preferredLanAddress()` /
 * `rankedLanAddresses()` for the QR primary URL.
 */
export function lanAddresses(interfaces: InterfaceMap = networkInterfaces()): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) found.add(entry.address);
    }
  }
  return [...found].sort();
}
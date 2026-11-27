import { desktopCapturer } from "electron";

/**
 * Cache de fontes de captura com TTL curto. Evita chamar
 * `desktopCapturer.getSources` duas vezes por início de espelhamento:
 * uma vez no dropdown da UI (`mirror:listSources`) e outra no
 * `setDisplayMediaRequestHandler` ao validar o sourceId.
 */
type CachedSources = {
  sources: Electron.DesktopCapturerSource[];
  fetchedAt: number;
};

const TTL_MS = 5000;
let cache: CachedSources | null = null;

export async function listSourcesCached(): Promise<Electron.DesktopCapturerSource[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.sources;
  }
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 0, height: 0 },
  });
  cache = { sources, fetchedAt: now };
  return sources;
}

export function invalidateSourcesCache(): void {
  cache = null;
}

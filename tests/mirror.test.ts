import assert from "node:assert/strict";
import test from "node:test";

import type { MirrorState } from "../src/renderer/mirror.ts";

// --- Mocks do ambiente de navegador (Rodar em Node, não há window real) ---

type FakeTrack = {
  kind: string;
  enabled: boolean;
  stopped: boolean;
  applyConstraints?: (c: unknown) => Promise<void>;
  getSettings?: () => { displaySurface?: string };
  stop: () => void;
};

function fakeTrack(kind: string): FakeTrack {
  return {
    kind,
    enabled: true,
    stopped: false,
    getSettings: () => ({}),
    applyConstraints: async () => undefined,
    stop() {
      this.stopped = true;
    },
  };
}

type FakeSender = {
  track: FakeTrack | null;
  getParameters: () => { encodings: Array<Record<string, unknown>> };
  setParameters: (p: unknown) => Promise<void>;
  getStats: () => Promise<Map<string, Record<string, unknown>>>;
  setStats: (report: Map<string, Record<string, unknown>>) => void;
};

function fakeSender(track: FakeTrack | null): FakeSender {
  let encodings: Array<Record<string, unknown>> = [];
  let stats = new Map<string, Record<string, unknown>>();
  return {
    track,
    // getParameters() devolve um snapshot no WebRTC real: mutations em params só viram estado
    // quando setParameters() confirma. Devolver a referência viva esconderia falhas de apply.
    getParameters: () => ({ encodings: encodings.map((entry) => ({ ...entry })) }),
    setParameters: async (p: unknown) => {
      encodings = (p as { encodings: Array<Record<string, unknown>> }).encodings.map((entry) => ({
        ...entry,
      }));
    },
    getStats: async () => stats,
    setStats: (report) => {
      stats = report;
    },
  };
}

type FakePC = {
  connectionState: string;
  signalingState: string;
  localDescription: { sdp: string } | null;
  restartCount: number;
  closed: boolean;
  getConfiguration: () => { iceServers: [] };
  addTrack: (t: FakeTrack) => FakeSender;
  getSenders: () => FakeSender[];
  getTransceivers: () => Array<{ sender: { track: FakeTrack | null } }>;
  setCodecPreferences: () => void;
  createOffer: () => Promise<{ sdp: string }>;
  setLocalDescription: (d: { sdp: string }) => Promise<void>;
  restartIce: () => void;
  close: () => void;
  onicecandidate: ((e: { candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number; usernameFragment: string } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onsignalingstatechange: (() => void) | null;
};

function fakePC(): FakePC {
  let connectionState = "connecting";
  let closed = false;
  const senders: FakeSender[] = [];
  const transceivers: Array<{ sender: { track: FakeTrack | null } }> = [];
  const pc: FakePC = {
    get connectionState() {
      return connectionState;
    },
    set connectionState(v) {
      connectionState = v;
    },
    signalingState: "stable",
    localDescription: null,
    restartCount: 0,
    get closed() {
      return closed;
    },
    getConfiguration: () => ({ iceServers: [] }),
    addTrack: (t: FakeTrack) => {
      const s = fakeSender(t);
      const transceiver = {
        sender: { track: t },
        setCodecPreferences: () => undefined,
      };
      senders.push(s);
      transceivers.push(transceiver);
      return s;
    },
    getSenders: () => senders,
    getTransceivers: () => transceivers,
    setCodecPreferences: () => undefined,
    createOffer: async () => ({ sdp: "v=0" }),
    setLocalDescription: async (d) => {
      pc.localDescription = d;
    },
    restartIce: () => {
      pc.restartCount += 1;
    },
    close: () => {
      closed = true;
      connectionState = "closed";
    },
    onicecandidate: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
    onsignalingstatechange: null,
  };
  return pc;
}

type FakeStream = {
  tracks: FakeTrack[];
  getVideoTracks: () => FakeTrack[];
  getAudioTracks: () => FakeTrack[];
  getTracks: () => FakeTrack[];
};

function fakeStream(video: FakeTrack, audio: FakeTrack | null): FakeStream {
  const tracks = audio ? [video, audio] : [video];
  return {
    tracks,
    getVideoTracks: () => [video],
    getAudioTracks: () => (audio ? [audio] : []),
    getTracks: () => tracks,
  };
}

// --- Mocks globais ---

const createdPCs: FakePC[] = [];
const intervalCallbacks: Array<() => unknown> = [];
let getDisplayMediaImpl: (() => Promise<FakeStream>) | null = null;
let mirrorStartImpl: ((req: unknown) => Promise<{ audio: boolean }>) | null = null;

let originalNavigator: unknown;
let originalWindow: unknown;
let originalRTCPeerConnection: unknown;

function installBrowserMocks(): void {
  originalNavigator = globalThis.navigator;
  originalWindow = globalThis.window;
  originalRTCPeerConnection = globalThis.RTCPeerConnection;

  Object.defineProperty(globalThis, "window", {
    value: {
      mirror: {
        start: async (req: unknown) =>
          mirrorStartImpl ? mirrorStartImpl(req) : { audio: false },
        stop: () => undefined,
        setAudio: async () => true,
        onSignal: () => undefined,
        sendSignal: () => undefined,
        onState: () => undefined,
        listSources: async () => [],
        capabilities: async () => ({ audio: true }),
      },
      setInterval: (fn: () => unknown) => {
        intervalCallbacks.push(fn);
        return intervalCallbacks.length;
      },
      clearInterval: () => undefined,
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getDisplayMedia: async () => {
          if (!getDisplayMediaImpl)
            throw new DOMException("no impl", "NotSupportedError");
          return getDisplayMediaImpl();
        },
      },
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        createdPCs.push(pc);
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "RTCRtpSender", {
    value: {
      getCapabilities: () => ({ codecs: [] }),
    },
    writable: true,
    configurable: true,
  });
}

function resetMocks(): void {
  createdPCs.length = 0;
  intervalCallbacks.length = 0;
  getDisplayMediaImpl = null;
  mirrorStartImpl = null;

  if (originalNavigator !== undefined) {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  }
  if (originalWindow !== undefined) {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  }
  if (originalRTCPeerConnection !== undefined) {
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: originalRTCPeerConnection,
      writable: true,
      configurable: true,
    });
  }
}

async function importMirror() {
  return import("../src/renderer/mirror.ts");
}

async function fireStatsTicks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    for (const callback of [...intervalCallbacks]) await callback();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function videoReport(
  reason: string | null,
  fractionLost: number | null,
  sample: number,
  bytesSent?: number,
): Map<string, Record<string, unknown>> {
  const report = new Map<string, Record<string, unknown>>();
  report.set("out", {
    type: "outbound-rtp",
    kind: "video",
    ssrc: 1,
    qualityLimitationReason: reason ?? undefined,
    framesEncoded: sample * 30,
    timestamp: sample * 3000,
    ...(bytesSent === undefined ? {} : { bytesSent }),
  });
  if (fractionLost !== null) {
    report.set("in", {
      type: "remote-inbound-rtp",
      kind: "video",
      ssrc: 1,
      fractionLost,
      timestamp: sample * 3000,
    });
  }
  return report;
}

test("start(): falha após getDisplayMedia encerra todas as tracks", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const audio = fakeTrack("audio");
  const stream = fakeStream(video, audio);

  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: true });

  // applyConstraints lança após a captura ter sido adquirida
  Object.defineProperty(video, "applyConstraints", {
    value: async () => {
      throw new Error("constraints rejected");
    },
    writable: true,
    configurable: true,
  });

  const RealRTCPC = globalThis.RTCPeerConnection;

  const { createMirror } = await importMirror();
  const mirror = createMirror();

  const result = await mirror.start({ sourceId: "screen", quality: "1080p", audio: true });
  assert.equal(result.ok, false);

  // Todas as tracks da captura devem estar paradas (release() chamado pelo fail())
  assert.equal(video.stopped, true, "video track must be stopped");
  assert.equal(audio.stopped, true, "audio track must be stopped");

  // Nenhum pc deve ficar aberto (release() fecha o pc)
  const openPCs = createdPCs.filter((pc) => !pc.closed);
  assert.equal(openPCs.length, 0, "no open peer connection should survive");

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("start(): getDisplayMedia rejeitado não vaza tracks (nenhuma adquirida)", async (t) => {
  installBrowserMocks();

  getDisplayMediaImpl = async () => {
    throw new DOMException("denied", "NotAllowedError");
  };
  mirrorStartImpl = async () => ({ audio: false });

  const { createMirror } = await importMirror();
  const mirror = createMirror();

  const result = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(result.ok, false);
  assert.equal(createdPCs.length, 0, "no peer connection created when capture fails");

  t.after(() => resetMocks());
});

test("setQuality(): 1080p → native limpa maxBitrate e maxFramerate do sender", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);

  let lastSender: { getParameters: () => { encodings: Array<Record<string, unknown>> }; setParameters: (p: unknown) => Promise<void> } | null = null;
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        lastSender = pc.addTrack(video);
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  const { createMirror } = await importMirror();
  const mirror = createMirror();

  const started = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(started.ok, true, `start failed: ${(started as { error?: string }).error ?? "unknown"}`);

  // Sender deve ter maxBitrate e maxFramerate definidos em 1080p
  const s1080 = lastSender!;
  const p1080 = s1080.getParameters();
  assert.equal(p1080.encodings[0]!.maxBitrate, 5_000_000);
  assert.equal(p1080.encodings[0]!.maxFramerate, 30);

  // Mudar para native deve limpar os limites (sem retorno antecipado vazio)
  const ok = await mirror.setQuality("native");
  assert.equal(ok, true);

  const pNative = s1080.getParameters();
  assert.equal(
    pNative.encodings[0]!.maxBitrate,
    undefined,
    "native must clear maxBitrate",
  );
  assert.equal(
    pNative.encodings[0]!.maxFramerate,
    undefined,
    "native must clear maxFramerate",
  );

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("setQuality(): falha de setParameters reverte constraints da track e retorna false", async (t) => {
  installBrowserMocks();

  const appliedConstraints: unknown[] = [];
  const video = {
    ...fakeTrack("video"),
    applyConstraints: async (c: unknown) => {
      appliedConstraints.push(c);
    },
  };
  const stream = fakeStream(video, null);

  let lastSender: { getParameters: () => { encodings: Array<Record<string, unknown>> }; setParameters: (p: unknown) => Promise<void> } | null = null;
  let setParametersShouldFail = false;
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        lastSender = pc.addTrack(video);
        const origSet = lastSender!.setParameters.bind(lastSender!);
        lastSender!.setParameters = async (_p: unknown) => {
          if (setParametersShouldFail) throw new Error("setParameters rejected");
          return origSet(_p);
        };
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  const { createMirror } = await importMirror();
  const mirror = createMirror();
  let lastQuality: MirrorState["quality"] | null = null;
  mirror.onChange((state) => {
    lastQuality = state.quality;
  });

  const started = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(started.ok, true, `start failed: ${(started as { error?: string }).error ?? "unknown"}`);
  assert.equal(appliedConstraints.length, 1, "1080p constraints applied at start");

  // Tentar mudar para 720p com setParameters falhando
  setParametersShouldFail = true;
  const ok = await mirror.setQuality("720p");
  assert.equal(ok, false, "setQuality should return false when setParameters fails");

  // As constraints da track devem ter revertido para 1080p (qualidade anterior)
  const lastApplied = appliedConstraints[appliedConstraints.length - 1];
  assert.match(
    JSON.stringify(lastApplied),
    /1920/,
    "track constraints reverted to 1080p (width 1920)",
  );
  assert.equal(lastQuality, "1080p", "a qualidade publicada volta à anterior no revert");

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("start(): aviso de bitrate cap não é sobrescrito por error: null ao entrar em waiting", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);

  let bitrateErrorEmitted = false;
  let lastState: { status: string; error: string | null } | null = { status: "", error: null };
  let lastSender: { setParameters: (p: unknown) => Promise<void> } | null = null;
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        lastSender = pc.addTrack(video);
        lastSender!.setParameters = async () => {
          throw new Error("cap failed");
        };
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  const { createMirror } = await importMirror();
  const mirror = createMirror();

  mirror.onChange((state) => {
    lastState = { status: state.status, error: state.error };
    if (state.error?.includes("Bitrate cap")) bitrateErrorEmitted = true;
  });

  const result = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(result.ok, true, "start should succeed despite non-critical bitrate warning");
  assert.equal(bitrateErrorEmitted, true, "bitrate cap warning must be emitted");

  // O estado final deve ser "waiting" mas deve PRESERVAR o error (não sobrescrever com null)
  assert.equal(lastState?.status, "waiting", "status should be waiting");
  assert.ok(
    lastState?.error?.includes("Bitrate cap"),
    "bitrate cap warning must persist in waiting state",
  );

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

type CapturedParams = {
  encodings: Array<Record<string, unknown>>;
  degradationPreference?: string;
  scaleResolutionDownBy?: number;
};

test("stats: CPU usa 1.5, rede nunca reduz resolução e bitrate segue a histerese", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);

  const captured: { params: CapturedParams | null } = { params: null };
  let capturedSender: FakeSender | null = null;
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        const sender = pc.addTrack(video);
        const original = sender.setParameters.bind(sender);
        sender.setParameters = async (p: unknown) => {
          captured.params = p as CapturedParams;
          await original(p);
        };
        capturedSender = sender;
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  const { createMirror } = await importMirror();
  const mirror = createMirror();
  const started = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(started.ok, true);

  assert.equal(captured.params?.degradationPreference, "maintain-resolution");
  assert.equal(captured.params?.scaleResolutionDownBy, 1.0);
  assert.equal(captured.params?.encodings[0]?.scaleResolutionDownBy, 1.0);
  assert.equal(captured.params?.encodings[0]?.maxBitrate, 5_000_000);

  capturedSender!.setStats(videoReport("cpu", null, 1));
  await fireStatsTicks(1);
  assert.equal(captured.params?.scaleResolutionDownBy, 1.5, "CPU valve must reach params top level");
  assert.equal(
    captured.params?.encodings[0]?.scaleResolutionDownBy,
    1.5,
    "CPU valve must reach encodings[0]",
  );

  capturedSender!.setStats(videoReport("bandwidth", 0.05, 2));
  await fireStatsTicks(2);
  assert.equal(captured.params?.scaleResolutionDownBy, 1.0, "LAN loss must never scale down");
  assert.equal(captured.params?.encodings[0]?.scaleResolutionDownBy, 1.0);
  assert.equal(captured.params?.encodings[0]?.maxBitrate, 4_000_000);
  assert.equal(captured.params?.degradationPreference, "maintain-resolution");

  capturedSender!.setStats(videoReport("none", 0.001, 3));
  await fireStatsTicks(5);
  assert.equal(captured.params?.encodings[0]?.maxBitrate, 4_400_000);
  assert.equal(captured.params?.scaleResolutionDownBy, 1.0);

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("start(): no máximo dois ICE restarts por episódio; connected zera o orçamento", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });

  const { createMirror } = await importMirror();
  const mirror = createMirror();
  let lastStatus = "";
  mirror.onChange((state) => {
    lastStatus = state.status;
  });

  const started = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(started.ok, true);

  const pc = createdPCs[0]!;
  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 1);
  assert.equal(lastStatus, "reconnecting");

  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 2, "segundo restart consecutivo é permitido");

  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(lastStatus, "live");

  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 3, "connected zera o orçamento");

  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 4, "o episódio após connected tem seu próprio orçamento");

  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 4, "terceiro restart no mesmo episódio não pode acontecer");
  assert.equal(lastStatus, "error");
  assert.equal(pc.closed, true);
  assert.equal(video.stopped, true);

  t.after(() => resetMocks());
});

test("applyVideoBitrateCap: degradationPreference no nível de cima de params, não só em encodings[0]", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);

  let capturedParams: unknown = null;
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        const sender = pc.addTrack(video);
        sender.setParameters = async (_p: unknown) => {
          capturedParams = _p;
        };
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  const { createMirror } = await importMirror();
  const mirror = createMirror();

  const started = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(started.ok, true);

  const params = capturedParams as { encodings: Array<Record<string, unknown>>; degradationPreference?: string; scaleResolutionDownBy?: number } | null;
  assert.equal(params?.degradationPreference, "maintain-resolution", "degradationPreference deve estar no nível de cima de params");
  assert.equal(params?.scaleResolutionDownBy, 1.0, "scaleResolutionDownBy deve estar no nível de cima de params");
  assert.equal(params?.encodings[0]?.degradationPreference, undefined, "degradationPreference não deve ficar só dentro de encodings[0]");

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("timer: falha de setParameters não avança a histerese", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);
  const captured: { params: CapturedParams | null } = { params: null };
  let failParams = false;
  let sender: FakeSender | null = null;

  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        const next = pc.addTrack(video);
        const original = next.setParameters.bind(next);
        next.setParameters = async (p: unknown) => {
          if (failParams) throw new Error("sender closed");
          await original(p);
          captured.params = p as CapturedParams;
        };
        sender = next;
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  const { createMirror } = await importMirror();
  const mirror = createMirror();
  assert.equal((await mirror.start({ sourceId: "screen", quality: "1080p", audio: false })).ok, true);

  failParams = true;
  sender!.setStats(videoReport("bandwidth", 0.05, 1));
  await fireStatsTicks(1);
  sender!.setStats(videoReport("bandwidth", 0.05, 2));
  await fireStatsTicks(1);
  assert.equal(captured.params?.encodings[0]?.maxBitrate, 5_000_000, "o encoder não mudou");

  failParams = false;
  sender!.setStats(videoReport("none", 0.001, 3));
  await fireStatsTicks(5);
  assert.equal(
    captured.params?.encodings[0]?.maxBitrate,
    5_000_000,
    "a decisão falha não pode virar estado interno: cinco boas amostras não devem aplicar 4,4 Mbps",
  );

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("fila de params: degrau anterior não sobrevive a uma troca de qualidade", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);
  const captured: { params: CapturedParams | null } = { params: null };
  const gate = deferred();
  let blockNextParams = false;
  let sender: FakeSender | null = null;

  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        const next = pc.addTrack(video);
        const original = next.setParameters.bind(next);
        next.setParameters = async (p: unknown) => {
          if (blockNextParams) {
            blockNextParams = false;
            await gate.promise;
          }
          await original(p);
          captured.params = p as CapturedParams;
        };
        sender = next;
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });

  const { createMirror } = await importMirror();
  const mirror = createMirror();
  let lastQuality: MirrorState["quality"] | null = null;
  mirror.onChange((state) => {
    lastQuality = state.quality;
  });
  assert.equal((await mirror.start({ sourceId: "screen", quality: "1080p", audio: false })).ok, true);

  // Primeira amostra ruim: ainda não aplica, mas deixa o streak do meio do caminho.
  sender!.setStats(videoReport("bandwidth", 0.05, 1));
  await fireStatsTicks(1);

  // setQuality bloqueia dentro de setParameters; o timer enfileira o degrau atrás dele.
  blockNextParams = true;
  const changed = mirror.setQuality("720p");
  await flush();

  sender!.setStats(videoReport("bandwidth", 0.05, 2));
  const tick = intervalCallbacks.at(-1)!();
  await flush();
  gate.resolve();
  await tick;
  assert.equal(await changed, true);
  await flush();
  assert.equal(lastQuality, "720p", "a qualidade publicada acompanha o setQuality aplicado");

  assert.equal(
    captured.params?.encodings[0]?.maxBitrate,
    5_000_000,
    "o degrau enfileirado antes do reset não pode ser aplicado à nova qualidade",
  );

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("restart ignorado com sinalização ocupada não consome o orçamento", async (t) => {
  installBrowserMocks();

  const video = fakeTrack("video");
  const stream = fakeStream(video, null);
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });

  const { createMirror } = await importMirror();
  const mirror = createMirror();
  assert.equal((await mirror.start({ sourceId: "screen", quality: "1080p", audio: false })).ok, true);

  const pc = createdPCs[0]!;
  pc.signalingState = "have-local-offer";
  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 0, "oferta em voo não pode ser interrompida");

  pc.signalingState = "stable";
  pc.onsignalingstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 1, "o restart pendente deve sair quando a sinalização estabiliza");

  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await flush();
  assert.equal(pc.restartCount, 2, "o segundo restart continua disponível");

  t.after(() => resetMocks());
});

test("stats: expõe métricas ao onChange e zera no stop", async (t) => {
  installBrowserMocks();
  const video = fakeTrack("video");
  const stream = fakeStream(video, null);
  let sender: FakeSender | null = null;
  getDisplayMediaImpl = async () => stream;
  mirrorStartImpl = async () => ({ audio: false });
  const RealRTCPC = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: class {
      constructor() {
        const pc = fakePC();
        sender = pc.addTrack(video);
        return pc;
      }
    } as unknown,
    writable: true,
    configurable: true,
  });
  const { createMirror } = await importMirror();
  const mirror = createMirror();
  const seen: Array<{ fps: number | null; bitrateBps: number | null }> = [];
  let lastState: MirrorState = {
    status: "idle",
    error: null,
    audio: false,
    lowFpsWarning: null,
    metrics: null,
    quality: "1080p",
  };
  mirror.onChange((s) => {
    lastState = s;
    if (s.metrics !== null) seen.push(s.metrics);
  });

  const started = await mirror.start({ sourceId: "screen", quality: "1080p", audio: false });
  assert.equal(started.ok, true);
  assert.equal(seen.length, 0, "sem amostra não deve haver métrica");

  sender!.setStats(videoReport("none", null, 1, 1_000));
  await fireStatsTicks(1);
  assert.equal(seen.at(-1)?.fps, null, "primeira amostra não tem delta");

  sender!.setStats(videoReport("none", null, 2, 4_000));
  await fireStatsTicks(1);
  assert.ok((seen.at(-1)?.fps ?? 0) > 0);
  assert.ok((seen.at(-1)?.bitrateBps ?? 0) > 0);

  mirror.stop();
  assert.equal(lastState.metrics, null, "stop deve limpar o snapshot");
  assert.equal(lastState.quality, "1080p");

  t.after(() => {
    resetMocks();
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      value: RealRTCPC,
      writable: true,
      configurable: true,
    });
  });
});

test("onChange: unsubscribe interrompe as emissões", async (t) => {
  installBrowserMocks();
  const { createMirror } = await importMirror();
  const mirror = createMirror();
  let emissions = 0;
  const off = mirror.onChange(() => {
    emissions += 1;
  });
  const before = emissions;
  off();
  mirror.stop();
  assert.equal(emissions, before, "nenhuma emissão depois do unsubscribe");
  t.after(() => resetMocks());
});

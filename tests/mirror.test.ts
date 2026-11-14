import assert from "node:assert/strict";
import test from "node:test";

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
};

function fakeSender(track: FakeTrack | null): FakeSender {
  let encodings: Array<Record<string, unknown>> = [];
  return {
    track,
    getParameters: () => ({ encodings }),
    setParameters: async (p: unknown) => {
      encodings = (p as { encodings: Array<Record<string, unknown>> }).encodings;
    },
  };
}

type FakePC = {
  connectionState: string;
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
};

function fakePC(): FakePC {
  let connectionState = "connecting";
  let closed = false;
  const senders: FakeSender[] = [];
  const transceivers: Array<{ sender: { track: FakeTrack | null } }> = [];
  return {
    get connectionState() {
      return connectionState;
    },
    set connectionState(v) {
      connectionState = v;
    },
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
    setLocalDescription: async (_d) => undefined,
    restartIce: () => undefined,
    close: () => {
      closed = true;
      connectionState = "closed";
    },
    onicecandidate: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
  };
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
      setInterval: () => 1,
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
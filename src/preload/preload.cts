import type { HostState, MirrorApi, SourceInfo, StartRequest } from "../shared/ipc.ts";
import type { Signal } from "../shared/protocol.ts";

// Sandboxed preloads are CommonJS: this file is compiled to dist/preload/preload.cjs, so it may
// require electron and nothing else. Everything else the renderer gets goes through IPC.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api: MirrorApi = {
  listSources: () => ipcRenderer.invoke("mirror:listSources") as Promise<SourceInfo[]>,
  capabilities: () => ipcRenderer.invoke("mirror:capabilities") as Promise<{ audio: boolean }>,
  start: (request: StartRequest) =>
    ipcRenderer.invoke("mirror:start", request) as Promise<{ audio: boolean }>,
  setAudio: (on: boolean) => ipcRenderer.invoke("mirror:setAudio", on) as Promise<boolean>,
  stop: () => {
    ipcRenderer.send("mirror:stop");
  },
  onSignal: (callback: (signal: Signal) => void) => {
    const handler = (_event: unknown, signal: Signal) => callback(signal);
    ipcRenderer.on("mirror:signal", handler);
    return () => ipcRenderer.removeListener("mirror:signal", handler);
  },
  sendSignal: (signal: Signal) => {
    ipcRenderer.send("mirror:sendSignal", signal);
  },
  onState: (callback: (state: HostState) => void) => {
    const handler = (_event: unknown, state: HostState) => callback(state);
    ipcRenderer.on("mirror:state", handler);
    return () => ipcRenderer.removeListener("mirror:state", handler);
  },
};

contextBridge.exposeInMainWorld("mirror", api);

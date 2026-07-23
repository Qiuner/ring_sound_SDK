import {
  CommandTimeoutError,
  DeviceError,
  ProtocolError,
  TransportError,
  asBytes,
  toHex,
} from "./ring-sdk.js";

function fromHex(value) {
  const text = String(value || "").replace(/\s+/g, "");
  const result = new Uint8Array(text.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function packetFromJson(value) {
  return {
    command: value.command,
    body: fromHex(value.bodyHex),
    version: value.version,
    bodyCrc: value.bodyCrc,
  };
}

function bridgeError(detail, fallback) {
  const value = detail?.detail || detail || {};
  const type = value.type || "Error";
  const message = value.message || fallback;
  if (type === "DeviceError") return new DeviceError(value.errorCode);
  if (type === "ProtocolError") return new ProtocolError(message);
  if (type === "TimeoutError") return new CommandTimeoutError(message);
  if (type === "TransportError") return new TransportError(message);
  const error = new Error(message);
  error.name = type;
  return error;
}

export class RingBridgeClient extends EventTarget {
  constructor({ timeoutMs = 10000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.autoTimeSync = true;
    this.writeChunkSize = 20;
    this.device = null;
    this.eventSource = null;
    this._connected = false;
  }

  static async available() {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) return false;
      const body = await response.json();
      return Boolean(body.ok && body.bleak);
    } catch {
      return false;
    }
  }

  get connected() {
    return this._connected;
  }

  async call(path, body = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw bridgeError(data, `${path} 请求失败`);
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new TransportError(`本地桥接请求超时: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  openEvents() {
    if (this.eventSource) return;
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.kind === "wire") {
        this.dispatchEvent(
          new CustomEvent("wire", {
            detail: {
              direction: data.direction,
              command: data.command,
              bytes: fromHex(data.bytesHex),
            },
          }),
        );
      } else if (data.kind === "packet") {
        this.dispatchEvent(new CustomEvent("packet", { detail: packetFromJson(data) }));
      } else if (data.kind === "connected") {
        this._connected = true;
        this.device = data.device;
      } else if (data.kind === "disconnected") {
        const wasConnected = this._connected;
        this._connected = false;
        this.device = null;
        if (wasConnected) this.dispatchEvent(new Event("disconnected"));
      } else if (data.kind === "error") {
        this.dispatchEvent(
          new CustomEvent("error", { detail: { error: bridgeError(data, "桥接服务错误") } }),
        );
      }
    };
    source.onerror = () => {
      if (this._connected) {
        this.dispatchEvent(
          new CustomEvent("error", {
            detail: { error: new TransportError("与本地 BLE 桥接服务的事件流中断") },
          }),
        );
      }
    };
    this.eventSource = source;
  }

  async scan({ timeoutS = 5, targetOnly = true } = {}) {
    this.openEvents();
    return (await this.call("/api/scan", { timeoutS, targetOnly })).devices;
  }

  async connect(address) {
    this.openEvents();
    const { device } = await this.call("/api/connect", { address }, 25000);
    this._connected = true;
    this.device = device;
    this.dispatchEvent(new CustomEvent("connected", { detail: { device } }));
    return device;
  }

  async disconnect() {
    await this.call("/api/disconnect");
    const wasConnected = this._connected;
    this._connected = false;
    this.device = null;
    if (wasConnected) this.dispatchEvent(new Event("disconnected"));
  }

  async sendCommand(command, body = new Uint8Array()) {
    await this.call("/api/send", {
      command,
      bodyHex: toHex(asBytes(body)).replaceAll(" ", ""),
    });
  }

  async request(command, responseCommand, body = new Uint8Array(), timeoutMs = this.timeoutMs) {
    const data = await this.call("/api/request", {
      command,
      responseCommand,
      bodyHex: toHex(asBytes(body)).replaceAll(" ", ""),
      timeoutMs,
    });
    return packetFromJson(data.packet);
  }

  async waitForCommand(command, timeoutMs = this.timeoutMs) {
    const data = await this.call("/api/wait", { command, timeoutMs });
    return packetFromJson(data.packet);
  }

  async drain(command) {
    if (!this.connected) return;
    await this.call("/api/drain", { command });
  }
}

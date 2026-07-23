export const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export const PROTOCOL_VERSION = 4;
export const HEADER_MAGIC = 0x3f;
export const HEADER_SIZE = 11;
export const MAX_BODY_LENGTH = 5120;

export const Commands = Object.freeze({
  GET_INFO: 0x0101,
  INFO_RESP: 0x0102,
  GET_LOG_STORAGE: 0x0301,
  LOG_STORAGE_RESP: 0x0302,
  GET_LOG: 0x0303,
  LOG_RESP: 0x0304,
  TIME_REQUEST: 0x0401,
  TIME_RESPONSE: 0x0402,
  GET_AUDIO_COUNT: 0x0501,
  AUDIO_COUNT_RESP: 0x0502,
  START_AUDIO_EXTRACT: 0x0503,
  AUDIO_FILE_INFO: 0x0504,
  AUDIO_DATA: 0x0505,
  NEXT_AUDIO_FRAME: 0x0506,
  END_AUDIO_EXTRACT: 0x0507,
  AUDIO_EXTRACT_DONE: 0x0508,
  START_AUDIO_QUICK: 0x0509,
  CLEAR_AUDIO: 0x050b,
  CLEAR_AUDIO_RESP: 0x050c,
  START_SENSOR: 0x0601,
  START_SENSOR_RESP: 0x0602,
  STOP_SENSOR: 0x0603,
  STOP_SENSOR_RESP: 0x0604,
  SENSOR_DATA: 0x0605,
  DOUBLE_TAP: 0x0701,
  GESTURE: 0x0702,
  KEY_DOUBLE_PRESS: 0x0703,
  KEY_SINGLE_PRESS: 0x0704,
});

export const COMMAND_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(Commands).map(([name, value]) => [value, name])),
);

const ERROR_MESSAGES = {
  1: "未知错误",
  2: "设备忙碌",
  3: "文件不存在",
  4: "命令组不存在",
  5: "命令不存在",
  6: "设备操作超时",
  7: "参数异常",
  8: "通信异常",
};

const PASSIVE_COMMANDS = new Set([
  Commands.TIME_REQUEST,
  Commands.SENSOR_DATA,
  Commands.DOUBLE_TAP,
  Commands.GESTURE,
  Commands.KEY_DOUBLE_PRESS,
  Commands.KEY_SINGLE_PRESS,
]);

export class RingSoundError extends Error {}
export class TransportError extends RingSoundError {}
export class ProtocolError extends RingSoundError {}
export class CommandTimeoutError extends RingSoundError {}

export class DeviceError extends RingSoundError {
  constructor(errorCode) {
    super(ERROR_MESSAGES[errorCode] || `设备错误 ${errorCode}`);
    this.errorCode = errorCode;
  }
}

export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value || 0);
}

export function concatBytes(...values) {
  const arrays = values.map(asBytes);
  const total = arrays.reduce((sum, item) => sum + item.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const item of arrays) {
    result.set(item, offset);
    offset += item.length;
  }
  return result;
}

export function toHex(value, maxLength = Infinity) {
  const bytes = asBytes(value);
  const visible = bytes.subarray(0, maxLength);
  const text = Array.from(visible, (item) => item.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > visible.length ? `${text} ... (+${bytes.length - visible.length})` : text;
}

export class BinaryReader {
  constructor(value) {
    this.bytesValue = asBytes(value);
    this.view = new DataView(
      this.bytesValue.buffer,
      this.bytesValue.byteOffset,
      this.bytesValue.byteLength,
    );
    this.offset = 0;
  }

  get remaining() {
    return this.bytesValue.length - this.offset;
  }

  require(size) {
    if (this.remaining < size) {
      throw new ProtocolError(`需要 ${size} 字节，当前只剩 ${this.remaining} 字节`);
    }
  }

  u8() {
    this.require(1);
    return this.view.getUint8(this.offset++);
  }

  u16() {
    this.require(2);
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  i16() {
    this.require(2);
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  u32() {
    this.require(4);
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  bytes(size) {
    this.require(size);
    const result = this.bytesValue.slice(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }

  stringU16() {
    return new TextDecoder().decode(this.bytes(this.u16()));
  }

  ensureDone(context = "包体") {
    if (this.remaining !== 0) {
      throw new ProtocolError(`${context}存在 ${this.remaining} 个多余字节`);
    }
  }
}

export class BinaryWriter {
  constructor() {
    this.parts = [];
  }

  u8(value) {
    this.parts.push(Uint8Array.of(Number(value) & 0xff));
    return this;
  }

  u16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, Number(value) & 0xffff, false);
    this.parts.push(bytes);
    return this;
  }

  u32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, Number(value) >>> 0, false);
    this.parts.push(bytes);
    return this;
  }

  bytes(value) {
    this.parts.push(asBytes(value));
    return this;
  }

  build() {
    return concatBytes(...this.parts);
  }
}

export function crc16Compute(value, initial = 0xffff) {
  let crc = initial & 0xffff;
  for (const byte of asBytes(value)) {
    crc = ((crc >>> 8) | ((crc << 8) & 0xffff)) & 0xffff;
    crc ^= byte;
    crc &= 0xffff;
    crc ^= (crc & 0xff) >>> 4;
    crc &= 0xffff;
    crc ^= (crc << 8) << 4;
    crc &= 0xffff;
    crc ^= ((crc & 0xff) << 4) << 1;
    crc &= 0xffff;
  }
  return crc;
}

export function encodePacket(command, body = new Uint8Array()) {
  const payload = asBytes(body);
  if (payload.length > MAX_BODY_LENGTH) {
    throw new ProtocolError(`包体过大: ${payload.length} bytes`);
  }
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint8(0, HEADER_MAGIC);
  view.setUint16(1, PROTOCOL_VERSION, false);
  view.setUint16(3, Number(command) & 0xffff, false);
  view.setUint32(5, payload.length, false);
  view.setUint16(9, payload.length ? crc16Compute(payload) : 0, false);
  return concatBytes(header, payload);
}

export function decodePacket(value) {
  const bytes = asBytes(value);
  if (bytes.length < HEADER_SIZE) throw new ProtocolError("协议包头不完整");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint8(0);
  const version = view.getUint16(1, false);
  const command = view.getUint16(3, false);
  const bodyLength = view.getUint32(5, false);
  const bodyCrc = view.getUint16(9, false);
  if (magic !== HEADER_MAGIC) throw new ProtocolError(`错误 magic: 0x${magic.toString(16)}`);
  if (version > PROTOCOL_VERSION) throw new ProtocolError(`不支持协议版本 ${version}`);
  if (bodyLength > MAX_BODY_LENGTH) throw new ProtocolError(`包体过大: ${bodyLength} bytes`);
  if (bytes.length !== HEADER_SIZE + bodyLength) {
    throw new ProtocolError(`协议包长度不匹配: 声明 ${bodyLength}，实际 ${bytes.length - HEADER_SIZE}`);
  }
  const body = bytes.slice(HEADER_SIZE);
  const actualCrc = body.length ? crc16Compute(body) : 0;
  if (actualCrc !== bodyCrc) {
    throw new ProtocolError(
      `CRC 错误: 声明 0x${bodyCrc.toString(16)}，计算 0x${actualCrc.toString(16)}`,
    );
  }
  return { command, body, version, bodyCrc };
}

export class PacketStream {
  constructor() {
    this.buffer = new Uint8Array();
  }

  clear() {
    this.buffer = new Uint8Array();
  }

  feed(value) {
    this.buffer = concatBytes(this.buffer, value);
    const packets = [];
    while (this.buffer.length) {
      const magicIndex = this.buffer.indexOf(HEADER_MAGIC);
      if (magicIndex < 0) {
        this.clear();
        return packets;
      }
      if (magicIndex > 0) this.buffer = this.buffer.slice(magicIndex);
      if (this.buffer.length < HEADER_SIZE) return packets;
      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      );
      const bodyLength = view.getUint32(5, false);
      if (bodyLength > MAX_BODY_LENGTH) {
        this.clear();
        throw new ProtocolError(`流中包体过大: ${bodyLength} bytes`);
      }
      const packetLength = HEADER_SIZE + bodyLength;
      if (this.buffer.length < packetLength) return packets;
      packets.push(decodePacket(this.buffer.slice(0, packetLength)));
      this.buffer = this.buffer.slice(packetLength);
    }
    return packets;
  }
}

function ensureSuccess(reader) {
  const errorCode = reader.u16();
  if (errorCode !== 0) throw new DeviceError(errorCode);
  return errorCode;
}

function commandEvent(command, detail) {
  return new CustomEvent(`command:${command}`, { detail });
}

export class RingWebClient extends EventTarget {
  constructor({ timeoutMs = 10000, writeChunkSize = 20 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.writeChunkSize = writeChunkSize;
    this.autoTimeSync = true;
    this.device = null;
    this.server = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    this.stream = new PacketStream();
    this.queues = new Map();
    this.waiters = new Map();
    this.handleNotification = this.handleNotification.bind(this);
    this.handleDisconnect = this.handleDisconnect.bind(this);
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected);
  }

  async connect() {
    if (!navigator.bluetooth) throw new TransportError("当前浏览器不支持 Web Bluetooth");
    this.device = await navigator.bluetooth.requestDevice({
      // Some Windows adapters do not expose the custom NUS service in the
      // browser's advertisement filter even though the service is available
      // after connection. Match the ring's advertised name instead.
      filters: [{ namePrefix: "ring" }, { namePrefix: "Ring" }],
      optionalServices: [NUS_SERVICE_UUID],
    });
    this.device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(NUS_SERVICE_UUID);
    this.rxCharacteristic = await service.getCharacteristic(NUS_RX_UUID);
    this.txCharacteristic = await service.getCharacteristic(NUS_TX_UUID);
    await this.txCharacteristic.startNotifications();
    this.txCharacteristic.addEventListener("characteristicvaluechanged", this.handleNotification);
    this.dispatchEvent(new CustomEvent("connected", { detail: { device: this.device } }));
    return this.device;
  }

  async disconnect() {
    if (this.txCharacteristic) {
      this.txCharacteristic.removeEventListener(
        "characteristicvaluechanged",
        this.handleNotification,
      );
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.resetConnection();
  }

  handleDisconnect() {
    this.resetConnection();
    this.dispatchEvent(new Event("disconnected"));
  }

  resetConnection() {
    this.stream.clear();
    this.server = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new TransportError("BLE 连接已断开"));
      }
    }
    this.waiters.clear();
    this.queues.clear();
  }

  async writePacket(packet) {
    if (!this.connected || !this.rxCharacteristic) {
      throw new TransportError("请先连接戒指");
    }
    const bytes = asBytes(packet);
    const chunkSize = Math.max(1, Number(this.writeChunkSize) || 20);
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      if (
        this.rxCharacteristic.properties.writeWithoutResponse &&
        this.rxCharacteristic.writeValueWithoutResponse
      ) {
        await this.rxCharacteristic.writeValueWithoutResponse(chunk);
      } else if (this.rxCharacteristic.writeValueWithResponse) {
        await this.rxCharacteristic.writeValueWithResponse(chunk);
      } else {
        await this.rxCharacteristic.writeValue(chunk);
      }
    }
  }

  async sendCommand(command, body = new Uint8Array()) {
    const packet = encodePacket(command, body);
    this.dispatchEvent(
      new CustomEvent("wire", { detail: { direction: "tx", command, bytes: packet, body } }),
    );
    await this.writePacket(packet);
  }

  async request(command, responseCommand, body = new Uint8Array(), timeoutMs = this.timeoutMs) {
    await this.drain(responseCommand);
    const response = this.waitForCommand(responseCommand, timeoutMs);
    try {
      await this.sendCommand(command, body);
      return await response;
    } catch (error) {
      response.catch(() => {});
      throw error;
    }
  }

  waitForCommand(command, timeoutMs = this.timeoutMs) {
    const queue = this.queues.get(command);
    if (queue?.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(command) || [];
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.waiters.get(command) || [];
          this.waiters.set(
            command,
            current.filter((item) => item !== waiter),
          );
          reject(
            new CommandTimeoutError(
              `等待命令 0x${command.toString(16).padStart(4, "0")} 超时`,
            ),
          );
        }, Math.max(1, timeoutMs)),
      };
      waiters.push(waiter);
      this.waiters.set(command, waiters);
    });
  }

  drain(command) {
    this.queues.delete(command);
  }

  handleNotification(event) {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    try {
      for (const packet of this.stream.feed(bytes)) this.handlePacket(packet);
    } catch (error) {
      this.dispatchEvent(new CustomEvent("error", { detail: { error } }));
      this.stream.clear();
    }
  }

  handlePacket(packet) {
    this.dispatchEvent(
      new CustomEvent("wire", {
        detail: {
          direction: "rx",
          command: packet.command,
          bytes: encodePacket(packet.command, packet.body),
          body: packet.body,
        },
      }),
    );
    this.dispatchEvent(commandEvent(packet.command, packet));
    this.dispatchEvent(new CustomEvent("packet", { detail: packet }));

    const waiters = this.waiters.get(packet.command) || [];
    if (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(packet);
      this.waiters.set(packet.command, waiters);
    } else if (!PASSIVE_COMMANDS.has(packet.command)) {
      const queue = this.queues.get(packet.command) || [];
      queue.push(packet);
      this.queues.set(packet.command, queue);
    }

    if (packet.command === Commands.TIME_REQUEST && this.autoTimeSync) {
      this.respondToTimeRequest(packet).catch((error) => {
        this.dispatchEvent(new CustomEvent("error", { detail: { error } }));
      });
    }
  }

  async respondToTimeRequest(packet) {
    const reader = new BinaryReader(packet.body);
    const requestTime = reader.u32();
    reader.ensureDone("校时请求");
    const now = Math.floor(Date.now() / 1000);
    const body = new BinaryWriter().u32(requestTime).u32(now).u32(now).build();
    await this.sendCommand(Commands.TIME_RESPONSE, body);
  }
}

export function parseSystemInfo(body) {
  const reader = new BinaryReader(body);
  ensureSuccess(reader);
  const result = {
    firmwareVersion: reader.stringU16(),
    systemTime: reader.u32(),
    audioStorageTotal: reader.u32(),
    audioStorageAvailable: reader.u32(),
    batteryPercent: reader.u16(),
    batteryCharging: Boolean(reader.u8()),
    sn: reader.stringU16(),
    cpuid: reader.stringU16(),
    model: reader.stringU16(),
  };
  reader.ensureDone("系统信息");
  return result;
}

export async function getSystemInfo(client) {
  const packet = await client.request(Commands.GET_INFO, Commands.INFO_RESP);
  return parseSystemInfo(packet.body);
}

export async function getLogStorage(client) {
  const packet = await client.request(Commands.GET_LOG_STORAGE, Commands.LOG_STORAGE_RESP);
  const reader = new BinaryReader(packet.body);
  ensureSuccess(reader);
  const result = { pageSize: reader.u32(), totalLength: reader.u32() };
  reader.ensureDone("日志空间");
  return result;
}

export async function readLogChunk(client, index, offset, size) {
  const body = new BinaryWriter().u32(index).u32(offset).u32(size).build();
  const packet = await client.request(Commands.GET_LOG, Commands.LOG_RESP, body);
  const reader = new BinaryReader(packet.body);
  ensureSuccess(reader);
  const dataLength = reader.u32();
  if (reader.remaining !== dataLength) {
    throw new ProtocolError(`日志长度不匹配: 声明 ${dataLength}，实际 ${reader.remaining}`);
  }
  return reader.bytes(dataLength);
}

export async function getAudioFileCount(client) {
  const packet = await client.request(Commands.GET_AUDIO_COUNT, Commands.AUDIO_COUNT_RESP);
  const reader = new BinaryReader(packet.body);
  ensureSuccess(reader);
  const count = reader.u32();
  reader.ensureDone("录音数量");
  return count;
}

export function parseAudioFileInfo(body) {
  const reader = new BinaryReader(body);
  ensureSuccess(reader);
  const result = {
    fileIndex: reader.u32(),
    recordTime: reader.u32(),
    dataSize: reader.u32(),
  };
  reader.ensureDone("录音文件信息");
  return result;
}

export function parseAudioDataFrame(body) {
  const reader = new BinaryReader(body);
  ensureSuccess(reader);
  const fileIndex = reader.u32();
  const frameOffset = reader.u32();
  const frameSize = reader.u32();
  const isEnd = Boolean(reader.u8());
  if (reader.remaining !== frameSize) {
    throw new ProtocolError(`录音帧长度不匹配: 声明 ${frameSize}，实际 ${reader.remaining}`);
  }
  return { fileIndex, frameOffset, frameSize, isEnd, data: reader.bytes(frameSize) };
}

function audioFrameRequest(fileIndex, frameOffset) {
  return new BinaryWriter().u16(0).u32(fileIndex).u32(frameOffset).u16(0).build();
}

async function waitAudioFrame(client, fileIndex, timeoutMs = client.timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const remaining = Math.max(1, deadline - performance.now());
    const packet = await client.waitForCommand(Commands.AUDIO_DATA, remaining);
    const frame = parseAudioDataFrame(packet.body);
    if (frame.fileIndex === fileIndex) return frame;
  }
}

function mergeAudioFrame(target, receivedLength, frame, expectedSize) {
  if (frame.frameOffset > receivedLength) return { receivedLength, gap: true, grew: false };
  const data = frame.data.subarray(0, Math.max(0, expectedSize - frame.frameOffset));
  const overlap = receivedLength - frame.frameOffset;
  const overlapSize = Math.min(overlap, data.length);
  for (let index = 0; index < overlapSize; index += 1) {
    if (target[frame.frameOffset + index] !== data[index]) {
      throw new ProtocolError(`录音重叠数据冲突，偏移 ${frame.frameOffset + index}`);
    }
  }
  const newData = data.subarray(Math.max(0, overlap));
  target.set(newData, receivedLength);
  return {
    receivedLength: receivedLength + newData.length,
    gap: false,
    grew: newData.length > 0,
  };
}

export async function downloadAudioQuick(client, fileIndex, onProgress = () => {}) {
  await client.drain(Commands.AUDIO_FILE_INFO);
  await client.drain(Commands.AUDIO_DATA);
  const body = new BinaryWriter().u16(0).u32(fileIndex).build();
  await client.sendCommand(Commands.START_AUDIO_QUICK, body);
  const info = parseAudioFileInfo(
    (await client.waitForCommand(Commands.AUDIO_FILE_INFO)).body,
  );
  if (info.fileIndex !== fileIndex) {
    throw new ProtocolError(`录音索引不匹配: 请求 ${fileIndex}，返回 ${info.fileIndex}`);
  }
  if (info.dataSize <= 0) throw new ProtocolError(`无效录音大小 ${info.dataSize}`);

  const data = new Uint8Array(info.dataSize);
  let receivedLength = 0;
  let retries = 0;
  while (receivedLength < info.dataSize) {
    let frame;
    try {
      frame = await waitAudioFrame(client, fileIndex);
    } catch (error) {
      if (!(error instanceof CommandTimeoutError) || ++retries > 3) throw error;
      await client.sendCommand(
        Commands.NEXT_AUDIO_FRAME,
        audioFrameRequest(fileIndex, receivedLength),
      );
      continue;
    }
    const merged = mergeAudioFrame(data, receivedLength, frame, info.dataSize);
    if (merged.gap) {
      if (++retries > 3) {
        throw new ProtocolError(
          `录音缺帧: 期望偏移 ${receivedLength}，收到 ${frame.frameOffset}`,
        );
      }
      await client.sendCommand(
        Commands.NEXT_AUDIO_FRAME,
        audioFrameRequest(fileIndex, receivedLength),
      );
      continue;
    }
    receivedLength = merged.receivedLength;
    if (merged.grew) retries = 0;
    onProgress(receivedLength, info.dataSize);
    if (frame.isEnd && receivedLength < info.dataSize) {
      if (++retries > 3) {
        throw new ProtocolError(`录音提前结束: ${receivedLength}/${info.dataSize}`);
      }
      await client.sendCommand(
        Commands.NEXT_AUDIO_FRAME,
        audioFrameRequest(fileIndex, receivedLength),
      );
    }
  }
  return { info, data };
}

export async function receiveAutoAudio(client, onProgress = () => {}) {
  await client.drain(Commands.AUDIO_DATA);
  const first = parseAudioDataFrame((await client.waitForCommand(Commands.AUDIO_DATA, 60000)).body);
  const fileIndex = first.fileIndex;
  let capacity = Math.max(4096, first.frameOffset + first.frameSize);
  let data = new Uint8Array(capacity);
  let receivedLength = 0;
  let retries = 0;
  let frame = first;

  while (true) {
    if (frame.frameOffset > receivedLength) {
      if (++retries > 3) {
        throw new ProtocolError(`自动录音缺帧: 期望 ${receivedLength}，收到 ${frame.frameOffset}`);
      }
      await client.sendCommand(
        Commands.NEXT_AUDIO_FRAME,
        audioFrameRequest(fileIndex, receivedLength),
      );
    } else {
      const required = Math.max(receivedLength, frame.frameOffset + frame.frameSize);
      if (required > capacity) {
        capacity = Math.max(required, capacity * 2);
        const expanded = new Uint8Array(capacity);
        expanded.set(data);
        data = expanded;
      }
      const merged = mergeAudioFrame(data, receivedLength, frame, capacity);
      receivedLength = merged.receivedLength;
      if (merged.grew) retries = 0;
      onProgress(receivedLength, null);
      if (frame.isEnd) return { fileIndex, data: data.slice(0, receivedLength) };
    }
    try {
      frame = await waitAudioFrame(client, fileIndex, 10000);
    } catch (error) {
      if (!(error instanceof CommandTimeoutError) || ++retries > 3) throw error;
      await client.sendCommand(
        Commands.NEXT_AUDIO_FRAME,
        audioFrameRequest(fileIndex, receivedLength),
      );
    }
  }
}

export async function clearAudioFiles(client) {
  const packet = await client.request(Commands.CLEAR_AUDIO, Commands.CLEAR_AUDIO_RESP);
  const reader = new BinaryReader(packet.body);
  ensureSuccess(reader);
  reader.ensureDone("清空录音响应");
}

export async function startSensorReport(client) {
  const packet = await client.request(Commands.START_SENSOR, Commands.START_SENSOR_RESP);
  const reader = new BinaryReader(packet.body);
  ensureSuccess(reader);
  const result = {
    sampleRateHz: reader.u16(),
    accelRangeG: reader.u16(),
    gyroRangeDps: reader.u16(),
  };
  reader.ensureDone("开启 IMU 响应");
  return result;
}

export async function stopSensorReport(client) {
  const packet = await client.request(Commands.STOP_SENSOR, Commands.STOP_SENSOR_RESP);
  const reader = new BinaryReader(packet.body);
  ensureSuccess(reader);
  reader.ensureDone("停止 IMU 响应");
}

export function parseSensorData(body) {
  const reader = new BinaryReader(body);
  ensureSuccess(reader);
  const sequenceStart = reader.u32();
  const frameCount = reader.u16();
  const sampleSize = reader.u16();
  if (sampleSize !== 16) throw new ProtocolError(`不支持 IMU sample_size=${sampleSize}`);
  if (reader.remaining !== frameCount * sampleSize) {
    throw new ProtocolError(
      `IMU 包体长度不匹配: 期望 ${frameCount * sampleSize}，实际 ${reader.remaining}`,
    );
  }
  const samples = [];
  for (let index = 0; index < frameCount; index += 1) {
    samples.push({
      timestampMs: reader.u32(),
      accelX: reader.i16(),
      accelY: reader.i16(),
      accelZ: reader.i16(),
      gyroX: reader.i16(),
      gyroY: reader.i16(),
      gyroZ: reader.i16(),
    });
  }
  return { sequenceStart, frameCount, sampleSize, samples };
}

export function parseTimestampEvent(body) {
  const reader = new BinaryReader(body);
  const timestampMs = reader.u32();
  reader.ensureDone("事件");
  return { timestampMs };
}

export function parseGestureEvent(body) {
  const reader = new BinaryReader(body);
  const timestampMs = reader.u32();
  const gestureId = reader.u8();
  reader.ensureDone("手势事件");
  const names = { 0: "idle", 1: "rotate_back", 2: "rotate_front", 3: "wave" };
  return { timestampMs, gestureId, gestureName: names[gestureId] || `unknown(${gestureId})` };
}

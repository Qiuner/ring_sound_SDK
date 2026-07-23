import test from "node:test";
import assert from "node:assert/strict";
import {
  BinaryWriter,
  Commands,
  PacketStream,
  SoftwareGestureRecognizer,
  crc16Compute,
  decodePacket,
  downloadAudioQuick,
  encodePacket,
  parseAudioDataFrame,
  parseSensorData,
} from "../ring-sdk.js";

test("protocol packet round trip and stream fragmentation", () => {
  const body = Uint8Array.from([1, 2, 3, 4, 5]);
  const encoded = encodePacket(0x1234, body);
  const packet = decodePacket(encoded);
  assert.equal(packet.command, 0x1234);
  assert.deepEqual(packet.body, body);

  const stream = new PacketStream();
  assert.deepEqual(stream.feed(encoded.slice(0, 4)), []);
  const packets = stream.feed(encoded.slice(4));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].command, 0x1234);
});

test("CRC16 remains compatible with the Python SDK implementation", () => {
  assert.equal(crc16Compute(new TextEncoder().encode("abc123")), 0x1cab);
});

test("audio frame parser validates and returns frame data", () => {
  const body = new BinaryWriter()
    .u16(0)
    .u32(7)
    .u32(4096)
    .u32(3)
    .u8(1)
    .bytes(Uint8Array.from([9, 8, 7]))
    .build();
  const frame = parseAudioDataFrame(body);
  assert.equal(frame.fileIndex, 7);
  assert.equal(frame.frameOffset, 4096);
  assert.equal(frame.isEnd, true);
  assert.deepEqual(frame.data, Uint8Array.from([9, 8, 7]));
});

test("sensor parser reads signed six-axis samples", () => {
  const sample = new BinaryWriter()
    .u32(100)
    .u16(1)
    .u16(0xfffe)
    .u16(3)
    .u16(4)
    .u16(0xfffb)
    .u16(6)
    .build();
  const body = new BinaryWriter()
    .u16(0)
    .u32(20)
    .u16(1)
    .u16(16)
    .bytes(sample)
    .build();
  const batch = parseSensorData(body);
  assert.equal(batch.sequenceStart, 20);
  assert.equal(batch.samples[0].accelY, -2);
  assert.equal(batch.samples[0].gyroY, -5);
});

test("quick audio download assembles consecutive frames", async () => {
  const fileInfo = new BinaryWriter().u16(0).u32(2).u32(123).u32(5).build();
  const frame = (offset, data, isEnd) =>
    new BinaryWriter()
      .u16(0)
      .u32(2)
      .u32(offset)
      .u32(data.length)
      .u8(isEnd ? 1 : 0)
      .bytes(data)
      .build();
  const queues = new Map([
    [Commands.AUDIO_FILE_INFO, [{ body: fileInfo }]],
    [
      Commands.AUDIO_DATA,
      [
        { body: frame(0, Uint8Array.from([1, 2, 3]), false) },
        { body: frame(3, Uint8Array.from([4, 5]), true) },
      ],
    ],
  ]);
  const client = {
    timeoutMs: 100,
    drain() {},
    async sendCommand() {},
    async waitForCommand(command) {
      return queues.get(command).shift();
    },
  };

  const result = await downloadAudioQuick(client, 2);
  assert.equal(result.info.recordTime, 123);
  assert.deepEqual(result.data, Uint8Array.from([1, 2, 3, 4, 5]));
});

function imuSample(timestampMs, {
  accelX = 0,
  accelY = 0,
  accelZ = 2048,
  gyroX = 0,
  gyroY = 0,
  gyroZ = 0,
} = {}) {
  return { timestampMs, accelX, accelY, accelZ, gyroX, gyroY, gyroZ };
}

function recognizeSoftwareGesture(axis, value) {
  const recognizer = new SoftwareGestureRecognizer({
    sampleRateHz: 100,
    startAccelThreshold: 200,
    startGyroThreshold: 200,
    idleAccelThreshold: 80,
    idleGyroThreshold: 80,
    directionThreshold: 300,
    dominanceRatio: 1.1,
    minimumDurationMs: 30,
    idleDurationMs: 30,
    cooldownMs: 0,
  });
  recognizer.calibrate(
    Array.from({ length: 10 }, (_, index) => imuSample(index * 10)),
  );

  let result = null;
  let timestampMs = 100;
  for (let index = 0; index < 3; index += 1) {
    result ||= recognizer.push(imuSample(timestampMs));
    timestampMs += 10;
  }
  for (let index = 0; index < 5; index += 1) {
    const values = axis === "x" ? { accelX: value } : { accelY: value };
    result ||= recognizer.push(imuSample(timestampMs, values));
    timestampMs += 10;
  }
  for (let index = 0; index < 5; index += 1) {
    result ||= recognizer.push(imuSample(timestampMs));
    timestampMs += 10;
  }
  return result;
}

test("software gesture recognizer detects calibrated up and left swipes", () => {
  const up = recognizeSoftwareGesture("y", 800);
  assert.equal(up?.type, "gesture");
  assert.equal(up?.gestureName, "swipe_up");
  assert.equal(up?.axis, "y");

  const left = recognizeSoftwareGesture("x", -900);
  assert.equal(left?.type, "gesture");
  assert.equal(left?.gestureName, "swipe_left");
  assert.equal(left?.axis, "x");
});

test("software gesture recognizer rejects weak motion", () => {
  const result = recognizeSoftwareGesture("y", 100);
  assert.equal(result, null);
});

test("software gesture calibration reports completion metadata", () => {
  const recognizer = new SoftwareGestureRecognizer({
    calibrationSampleCount: 5,
  });
  recognizer.beginCalibration();
  let result = null;
  for (let index = 0; index < 5; index += 1) {
    result = recognizer.push(
      imuSample(index * 10, {
        accelX: 10,
        accelY: 20,
        accelZ: 2000,
        gyroX: 1,
        gyroY: 2,
        gyroZ: 3,
      }),
    );
  }
  assert.equal(result?.type, "calibration");
  assert.equal(result?.complete, true);
  assert.equal(result?.sampleCount, 5);
  assert.equal(result?.timestampMs, 40);
  assert.equal(result?.baseline.accelZ, 2000);
  assert.equal(result?.baseline.gyroY, 2);
});

import {
  COMMAND_NAMES,
  Commands,
  RingWebClient,
  clearAudioFiles,
  downloadAudioQuick,
  getAudioFileCount,
  getLogStorage,
  getSystemInfo,
  parseGestureEvent,
  parseSensorData,
  parseTimestampEvent,
  readLogChunk,
  receiveAutoAudio,
  startSensorReport,
  stopSensorReport,
  toHex,
} from "./ring-sdk.js";

const $ = (id) => document.getElementById(id);
const client = new RingWebClient();
const connectedControls = [
  "disconnectButton",
  "infoButton",
  "audioCountButton",
  "downloadAudioButton",
  "receiveAudioButton",
  "clearAudioButton",
  "startSensorButton",
  "logStorageButton",
  "readLogButton",
];

let currentAudio = null;
let consoleLines = [];
let errorRecords = [];
let toastTimer = null;
let sensorHistory = [];
let ringActionHistory = [];
const gestureStats = {
  rotate_back: {
    count: 0,
    countId: "rotateBackCount",
    timeId: "rotateBackTime",
    lastId: "rotateBackLast",
  },
  rotate_front: {
    count: 0,
    countId: "rotateFrontCount",
    timeId: "rotateFrontTime",
    lastId: "rotateFrontLast",
  },
  wave: {
    count: 0,
    countId: "waveCount",
    timeId: "waveTime",
    lastId: "waveLast",
  },
};

function setConnected(connected, deviceName = "") {
  $("statusDot").classList.toggle("connected", connected);
  $("statusText").textContent = connected ? "已连接" : "未连接";
  $("deviceName").textContent = connected ? deviceName || "未知 BLE 设备" : "等待选择设备";
  $("connectButton").disabled = connected;
  for (const id of connectedControls) $(id).disabled = !connected;
  $("stopSensorButton").disabled = true;
  if (!connected) {
    $("sensorBadge").classList.remove("active");
    $("sensorBadge").textContent = "未开启";
    resetSensorView();
  }
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function formatTime(seconds) {
  if (!seconds) return "--";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function formatClock(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function resetSensorView() {
  $("sensorRate").textContent = "采样率 --";
  $("sensorRange").textContent = "量程 --";
  $("accelValue").textContent = "-- / -- / --";
  $("gyroValue").textContent = "-- / -- / --";
  $("sequenceValue").textContent = "--";
  $("sensorTimestamp").textContent = "--";
  $("latestFrameText").textContent = "等待 0x0605 六轴帧";
  $("lastReceiveAt").textContent = "--";
  $("lastDoubleTapAt").textContent = "--";
  sensorHistory = [];
  ringActionHistory = [];
  renderSensorEvents();
  renderRingActions();
  for (const stat of Object.values(gestureStats)) {
    stat.count = 0;
    $(stat.countId).textContent = "0";
    $(stat.timeId).textContent = "--";
    $(stat.lastId).textContent = "--";
  }
}

function setBusy(button, busy, busyText = "处理中...") {
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

async function runAction(button, action, busyText) {
  const actionName = button.textContent.trim();
  setBusy(button, true, busyText);
  try {
    return await action();
  } catch (error) {
    recordError(error, actionName);
    showToast(error.message || String(error), true);
    throw error;
  } finally {
    setBusy(button, false);
    button.disabled = !client.connected;
  }
}

function appendConsole(direction, command, bytes, text = "") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const name = COMMAND_NAMES[command] || "UNKNOWN";
  const commandHex =
    command == null ? "----" : `0x${command.toString(16).padStart(4, "0").toUpperCase()}`;
  const line = { time, direction, commandHex, name, hex: text || toHex(bytes, 160) };
  consoleLines.push(line);
  if (consoleLines.length > 800) consoleLines = consoleLines.slice(-800);

  const element = document.createElement("div");
  element.className = "console-line";
  for (const [className, value] of [
    ["time", time],
    [direction, direction.toUpperCase()],
    ["command", commandHex],
    ["hex", `${name} ${line.hex}`],
  ]) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = value;
    element.append(span);
  }
  const output = $("protocolConsole");
  output.append(element);
  output.scrollTop = output.scrollHeight;
}

function logSystem(text, isError = false) {
  appendConsole("sys", null, new Uint8Array(), `${isError ? "ERROR " : ""}${text}`);
}

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorStack(error) {
  if (error instanceof Error && error.stack) return error.stack;
  return errorText(error);
}

function recordError(error, context = "未指定操作") {
  const record = {
    time: new Date(),
    context,
    kind: error?.constructor?.name || "Error",
    message: errorText(error),
    stack: errorStack(error),
  };
  errorRecords.unshift(record);
  errorRecords = errorRecords.slice(0, 100);
  renderErrors();
  logSystem(`${record.context}: ${record.kind}: ${record.message}`, true);
}

function errorExportText() {
  return errorRecords
    .map(
      (record) =>
        `[${record.time.toISOString()}] ${record.context}\n` +
        `${record.kind}: ${record.message}\n${record.stack}`,
    )
    .join("\n\n");
}

function renderErrors() {
  const list = $("errorList");
  $("errorCount").textContent = String(errorRecords.length);
  list.replaceChildren();
  if (!errorRecords.length) {
    const empty = document.createElement("div");
    empty.className = "error-empty";
    empty.textContent = "当前没有错误记录";
    list.append(empty);
    return;
  }
  for (const record of errorRecords) {
    const entry = document.createElement("details");
    entry.className = "error-entry";
    const summary = document.createElement("summary");
    const time = document.createElement("time");
    time.textContent = record.time.toLocaleTimeString("zh-CN", { hour12: false });
    const kind = document.createElement("span");
    kind.className = "error-kind";
    kind.textContent = `${record.kind} / ${record.context}`;
    const message = document.createElement("span");
    message.className = "error-message";
    message.textContent = record.message;
    summary.append(time, kind, message);

    const detail = document.createElement("div");
    detail.className = "error-detail";
    const location = document.createElement("p");
    location.textContent = `发生时间：${record.time.toLocaleString("zh-CN", { hour12: false })}`;
    const stack = document.createElement("pre");
    stack.textContent = record.stack;
    detail.append(location, stack);
    entry.append(summary, detail);
    list.append(entry);
  }
}

function updateAudioProgress(current, total) {
  if (total) {
    const percent = Math.min(100, Math.round((current * 100) / total));
    $("audioProgress").style.width = `${percent}%`;
    $("audioProgressText").textContent = `${formatBytes(current)} / ${formatBytes(total)} (${percent}%)`;
  } else {
    $("audioProgress").style.width = "35%";
    $("audioProgressText").textContent = `已接收 ${formatBytes(current)}，等待结束帧`;
  }
}

function showAudioResult(fileIndex, data, recordTime = 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `ring-sound-${String(fileIndex).padStart(3, "0")}-${stamp}.bin`;
  currentAudio = { fileName, data };
  $("audioFileName").textContent = fileName;
  $("audioMeta").textContent =
    `${formatBytes(data.length)}${recordTime ? ` / ${formatTime(recordTime)}` : ""}`;
  $("audioResult").hidden = false;
  $("audioProgress").style.width = "100%";
}

function saveBlob(fileName, bytes, type = "application/octet-stream") {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pushSensorEvent(label, detail, occurredAt = Date.now()) {
  sensorHistory.unshift({ label, detail, occurredAt });
  sensorHistory = sensorHistory.slice(0, 30);
  renderSensorEvents();
}

function renderSensorEvents() {
  const list = $("eventList");
  $("recentEventCount").textContent = String(sensorHistory.length);
  list.replaceChildren();
  if (!sensorHistory.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "等待六轴、按键或手势事件";
    list.append(empty);
    return;
  }
  for (const record of sensorHistory) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(record.occurredAt).toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    const text = document.createElement("span");
    text.textContent = record.detail ? `${record.label} ${record.detail}` : record.label;
    item.append(time, text);
    list.append(item);
  }
}

function recordGesture(gestureName, timestampMs) {
  const stat = gestureStats[gestureName];
  if (!stat) return;
  stat.count += 1;
  $(stat.countId).textContent = String(stat.count);
  $(stat.timeId).textContent = formatClock(Date.now());
  $(stat.lastId).textContent = `${timestampMs} ms`;
}

function pushRingAction(command, label, detail, occurredAt = Date.now()) {
  ringActionHistory.unshift({ command, label, detail, occurredAt });
  ringActionHistory = ringActionHistory.slice(0, 20);
  renderRingActions();
}

function renderRingActions() {
  const list = $("ringActionList");
  $("ringActionCount").textContent = String(ringActionHistory.length);
  list.replaceChildren();
  if (!ringActionHistory.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "等待双击、按键或手势事件";
    list.append(empty);
    $("latestRingAction").textContent = "--";
    $("latestRingActionTime").textContent = "--";
    return;
  }

  const latest = ringActionHistory[0];
  $("latestRingAction").textContent = latest.label;
  $("latestRingActionTime").textContent = formatClock(latest.occurredAt);
  for (const record of ringActionHistory) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(record.occurredAt).toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    const command = document.createElement("code");
    command.textContent = `0x${record.command.toString(16).padStart(4, "0")}`;
    const text = document.createElement("span");
    text.textContent = record.detail ? `${record.label} / ${record.detail}` : record.label;
    item.append(time, command, text);
    list.append(item);
  }
}

function handlePacket(packet) {
  try {
    if (packet.command === Commands.SENSOR_DATA) {
      const batch = parseSensorData(packet.body);
      const sample = batch.samples.at(-1);
      if (!sample) return;
      $("accelValue").textContent = `${sample.accelX} / ${sample.accelY} / ${sample.accelZ}`;
      $("gyroValue").textContent = `${sample.gyroX} / ${sample.gyroY} / ${sample.gyroZ}`;
      const latestSequence = batch.sequenceStart + batch.frameCount - 1;
      $("sequenceValue").textContent = String(latestSequence);
      $("sensorTimestamp").textContent = `${sample.timestampMs} ms`;
      const summary =
        `seq=${batch.sequenceStart}~${latestSequence}, frames=${batch.frameCount}, ` +
        `latest seq=${latestSequence}, uptime=${sample.timestampMs}ms, ` +
        `accel=(${sample.accelX}, ${sample.accelY}, ${sample.accelZ}), ` +
        `gyro=(${sample.gyroX}, ${sample.gyroY}, ${sample.gyroZ})`;
      $("latestFrameText").textContent = summary;
      $("lastReceiveAt").textContent = formatClock(Date.now());
      pushSensorEvent("0605", summary);
      return;
    }
    if (packet.command === Commands.GESTURE) {
      const event = parseGestureEvent(packet.body);
      recordGesture(event.gestureName, event.timestampMs);
      pushSensorEvent("0702", `${event.gestureName} / ${event.timestampMs} ms`);
      pushRingAction(
        packet.command,
        `HMM 手势：${event.gestureName}`,
        `设备时间 ${event.timestampMs} ms`,
      );
      return;
    }
    const eventLabels = {
      [Commands.DOUBLE_TAP]: "普通双击",
      [Commands.KEY_DOUBLE_PRESS]: "按键双击",
      [Commands.KEY_SINGLE_PRESS]: "按键单击 / 尝试切换模式",
    };
    if (eventLabels[packet.command]) {
      const event = parseTimestampEvent(packet.body);
      if (packet.command === Commands.DOUBLE_TAP) {
        $("lastDoubleTapAt").textContent = formatClock(Date.now());
      }
      pushSensorEvent(
        `0x${packet.command.toString(16).padStart(4, "0")}`,
        `${eventLabels[packet.command]} / ${event.timestampMs} ms`,
      );
      pushRingAction(
        packet.command,
        eventLabels[packet.command],
        `设备时间 ${event.timestampMs} ms`,
      );
    }
  } catch (error) {
    recordError(error, "主动事件解析");
  }
}

function bindClientEvents(target) {
  target.addEventListener("connected", ({ detail }) => {
    const identity =
      [detail.device.name, detail.device.address || detail.device.id].filter(Boolean).join(" / ") ||
      "未知 BLE 设备";
    setConnected(true, identity);
    logSystem(`BLE 已连接: ${identity}`);
    showToast("戒指已连接");
  });

  target.addEventListener("disconnected", () => {
    setConnected(false);
    logSystem("BLE 已断开");
    showToast("戒指连接已断开", true);
  });

  target.addEventListener("wire", ({ detail }) => {
    appendConsole(detail.direction, detail.command, detail.bytes);
  });

  target.addEventListener("packet", ({ detail }) => {
    handlePacket(detail);
  });
  target.addEventListener("error", ({ detail }) => {
    recordError(detail.error, "BLE/协议接收");
  });
}

bindClientEvents(client);

window.addEventListener("error", (event) => {
  recordError(event.error || new Error(event.message), "浏览器未捕获异常");
});

window.addEventListener("unhandledrejection", (event) => {
  recordError(event.reason || new Error("未处理的 Promise rejection"), "未处理异步异常");
});

$("connectButton").addEventListener("click", async () => {
  const button = $("connectButton");
  setBusy(button, true, "选择设备...");
  try {
    client.writeChunkSize = Number($("chunkSize").value);
    client.autoTimeSync = $("timeSyncToggle").checked;
    await client.connect();
  } catch (error) {
    recordError(error, "连接戒指");
    showToast(error.message || "连接失败", true);
  } finally {
    setBusy(button, false);
    button.disabled = client.connected;
  }
});

$("disconnectButton").addEventListener("click", () => client.disconnect());
$("chunkSize").addEventListener("change", (event) => {
  client.writeChunkSize = Number(event.target.value);
  logSystem(`BLE 写入分片调整为 ${client.writeChunkSize} bytes`);
});
$("timeSyncToggle").addEventListener("change", (event) => {
  client.autoTimeSync = event.target.checked;
  logSystem(`自动校时${client.autoTimeSync ? "已开启" : "已关闭"}`);
});

$("infoButton").addEventListener("click", () =>
  runAction(
    $("infoButton"),
    async () => {
      const info = await getSystemInfo(client);
      $("batteryValue").textContent = `${info.batteryPercent}%`;
      $("chargingValue").textContent = info.batteryCharging ? "正在充电" : "未充电";
      $("storageValue").textContent = formatBytes(info.audioStorageAvailable);
      $("storageTotal").textContent = `总容量 ${formatBytes(info.audioStorageTotal)}`;
      $("firmwareValue").textContent = info.firmwareVersion;
      $("modelValue").textContent = info.model;
      $("snValue").textContent = info.sn;
      $("cpuidValue").textContent = info.cpuid;
      $("systemTimeValue").textContent = formatTime(info.systemTime);
      showToast("设备信息已刷新");
    },
    "读取中...",
  ).catch(() => {}),
);

$("audioCountButton").addEventListener("click", () =>
  runAction(
    $("audioCountButton"),
    async () => {
      const count = await getAudioFileCount(client);
      $("audioCountValue").textContent = String(count);
      if (count > 0) $("audioIndex").max = String(count - 1);
      showToast(`设备中有 ${count} 条录音`);
    },
    "查询中...",
  ).catch(() => {}),
);

$("downloadAudioButton").addEventListener("click", () =>
  runAction(
    $("downloadAudioButton"),
    async () => {
      const fileIndex = Number($("audioIndex").value);
      $("audioResult").hidden = true;
      updateAudioProgress(0, 1);
      const { info, data } = await downloadAudioQuick(client, fileIndex, updateAudioProgress);
      showAudioResult(info.fileIndex, data, info.recordTime);
      showToast(`录音 ${info.fileIndex} 下载完成`);
    },
    "下载中...",
  ).catch(() => {}),
);

$("receiveAudioButton").addEventListener("click", () =>
  runAction(
    $("receiveAudioButton"),
    async () => {
      $("audioResult").hidden = true;
      $("audioProgressText").textContent = "等待设备录音保存后的 0x0505...";
      const { fileIndex, data } = await receiveAutoAudio(client, updateAudioProgress);
      showAudioResult(fileIndex, data);
      showToast(`自动录音 ${fileIndex} 接收完成`);
    },
    "等待录音...",
  ).catch(() => {}),
);

$("saveAudioButton").addEventListener("click", () => {
  if (currentAudio) saveBlob(currentAudio.fileName, currentAudio.data);
});

$("clearAudioButton").addEventListener("click", async () => {
  if (!window.confirm("将删除戒指内全部录音，且无法恢复。确定继续？")) return;
  await runAction(
    $("clearAudioButton"),
    async () => {
      await clearAudioFiles(client);
      $("audioCountValue").textContent = "0";
      showToast("设备录音已清空");
    },
    "清空中...",
  ).catch(() => {});
});

$("startSensorButton").addEventListener("click", () =>
  runAction(
    $("startSensorButton"),
    async () => {
      const info = await startSensorReport(client);
      $("sensorRate").textContent = `采样率 ${info.sampleRateHz} Hz`;
      $("sensorRange").textContent =
        `ACC ±${info.accelRangeG} g / GYRO ±${info.gyroRangeDps} dps`;
      $("sensorBadge").classList.add("active");
      $("sensorBadge").textContent = "实时上报";
      showToast("IMU 实时上报已开启");
    },
    "开启中...",
  )
    .then(() => {
      $("startSensorButton").disabled = true;
      $("stopSensorButton").disabled = false;
    })
    .catch(() => {}),
);

$("stopSensorButton").addEventListener("click", () =>
  runAction(
    $("stopSensorButton"),
    async () => {
      await stopSensorReport(client);
      $("sensorBadge").classList.remove("active");
      $("sensorBadge").textContent = "未开启";
      showToast("IMU 实时上报已停止");
    },
    "停止中...",
  )
    .then(() => {
      $("startSensorButton").disabled = false;
      $("stopSensorButton").disabled = true;
    })
    .catch(() => {}),
);

$("logStorageButton").addEventListener("click", () =>
  runAction(
    $("logStorageButton"),
    async () => {
      const info = await getLogStorage(client);
      $("logStorageValue").textContent =
        `page_size=${formatBytes(info.pageSize)} / total_len=${formatBytes(info.totalLength)}`;
      showToast("日志空间已读取");
    },
    "查询中...",
  ).catch(() => {}),
);

$("readLogButton").addEventListener("click", () =>
  runAction(
    $("readLogButton"),
    async () => {
      const data = await readLogChunk(
        client,
        Number($("logIndex").value),
        Number($("logOffset").value),
        Number($("logSize").value),
      );
      $("logOutput").value = new TextDecoder("utf-8").decode(data);
      showToast(`读取 ${data.length} 字节日志`);
    },
    "读取中...",
  ).catch(() => {}),
);

$("clearConsoleButton").addEventListener("click", () => {
  consoleLines = [];
  $("protocolConsole").replaceChildren();
});

$("exportConsoleButton").addEventListener("click", () => {
  const text = consoleLines
    .map((line) => `${line.time}\t${line.direction.toUpperCase()}\t${line.commandHex}\t${line.name}\t${line.hex}`)
    .join("\n");
  saveBlob(`ring-sound-console-${Date.now()}.txt`, new TextEncoder().encode(text), "text/plain");
});

$("clearErrorsButton").addEventListener("click", () => {
  errorRecords = [];
  renderErrors();
});

$("copyErrorsButton").addEventListener("click", async () => {
  const text = errorExportText();
  if (!text) {
    showToast("当前没有错误记录");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("错误信息已复制");
  } catch (error) {
    recordError(error, "复制错误信息");
    showToast("复制失败，请使用导出", true);
  }
});

function initialise() {
  setConnected(false);
  renderErrors();
  resetSensorView();
  $("browserWarning").hidden = Boolean(navigator.bluetooth);
  client.writeChunkSize = Number($("chunkSize").value);
  client.autoTimeSync = $("timeSyncToggle").checked;
  logSystem("Ring Sound Web Lab ready / protocol v4");
}

initialise();

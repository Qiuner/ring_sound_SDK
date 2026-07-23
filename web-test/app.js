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
import { RingBridgeClient } from "./bridge-client.js";

const $ = (id) => document.getElementById(id);
const webClient = new RingWebClient();
const bridgeClient = new RingBridgeClient();
let client = webClient;
let bridgeAvailable = false;
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

function setConnected(connected, deviceName = "") {
  $("statusDot").classList.toggle("connected", connected);
  $("statusText").textContent = connected ? "已连接" : "未连接";
  $("deviceName").textContent = connected ? deviceName || "未知 BLE 设备" : "等待选择设备";
  $("connectButton").disabled = connected;
  $("scanButton").disabled = connected || !bridgeAvailable;
  for (const id of connectedControls) $(id).disabled = !connected;
  $("stopSensorButton").disabled = true;
  if (!connected) {
    $("sensorBadge").classList.remove("active");
    $("sensorBadge").textContent = "未开启";
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

function addEvent(label, detail) {
  const list = $("eventList");
  list.querySelector(".empty")?.remove();
  const item = document.createElement("li");
  const text = document.createElement("span");
  const time = document.createElement("time");
  text.textContent = detail ? `${label} / ${detail}` : label;
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.append(text, time);
  list.prepend(item);
  while (list.children.length > 12) list.lastElementChild.remove();
}

function handlePacket(packet) {
  try {
    if (packet.command === Commands.SENSOR_DATA) {
      const batch = parseSensorData(packet.body);
      const sample = batch.samples.at(-1);
      if (!sample) return;
      $("accelValue").textContent = `${sample.accelX} / ${sample.accelY} / ${sample.accelZ}`;
      $("gyroValue").textContent = `${sample.gyroX} / ${sample.gyroY} / ${sample.gyroZ}`;
      $("sequenceValue").textContent = String(batch.sequenceStart + batch.frameCount - 1);
      $("sensorTimestamp").textContent = `${sample.timestampMs} ms`;
      return;
    }
    if (packet.command === Commands.GESTURE) {
      const event = parseGestureEvent(packet.body);
      addEvent("HMM 手势", `${event.gestureName} / ${event.timestampMs} ms`);
      return;
    }
    const eventLabels = {
      [Commands.DOUBLE_TAP]: "普通双击",
      [Commands.KEY_DOUBLE_PRESS]: "按键双击",
      [Commands.KEY_SINGLE_PRESS]: "按键单击 / 尝试切换模式",
    };
    if (eventLabels[packet.command]) {
      const event = parseTimestampEvent(packet.body);
      addEvent(eventLabels[packet.command], `${event.timestampMs} ms`);
    }
  } catch (error) {
    recordError(error, "主动事件解析");
  }
}

function bindClientEvents(target) {
  target.addEventListener("connected", ({ detail }) => {
    if (target !== client) return;
    const identity =
      [detail.device.name, detail.device.address || detail.device.id].filter(Boolean).join(" / ") ||
      "未知 BLE 设备";
    setConnected(true, identity);
    logSystem(`BLE 已连接: ${identity}`);
    showToast("戒指已连接");
  });

  target.addEventListener("disconnected", () => {
    if (target !== client) return;
    setConnected(false);
    logSystem("BLE 已断开");
    showToast("戒指连接已断开", true);
  });

  target.addEventListener("wire", ({ detail }) => {
    if (target !== client) return;
    appendConsole(detail.direction, detail.command, detail.bytes);
  });

  target.addEventListener("packet", ({ detail }) => {
    if (target === client) handlePacket(detail);
  });
  target.addEventListener("error", ({ detail }) => {
    if (target === client) recordError(detail.error, "BLE/协议接收");
  });
}

bindClientEvents(webClient);
bindClientEvents(bridgeClient);

window.addEventListener("error", (event) => {
  recordError(event.error || new Error(event.message), "浏览器未捕获异常");
});

window.addEventListener("unhandledrejection", (event) => {
  recordError(event.reason || new Error("未处理的 Promise rejection"), "未处理异步异常");
});

$("connectButton").addEventListener("click", async () => {
  if ($("connectionMode").value === "bridge") {
    await scanDevices();
    return;
  }
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

function renderNearbyDevices(devices) {
  const list = $("nearbyList");
  list.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement("div");
    empty.className = "nearby-empty";
    empty.textContent = "没有发现广播目标服务的戒指。确认戒指正在广播并且未被其他设备连接。";
    list.append(empty);
    return;
  }
  for (const device of devices) {
    const card = document.createElement("article");
    card.className = "nearby-device";
    const header = document.createElement("header");
    const name = document.createElement("h3");
    name.textContent = device.name || "Unknown";
    const signal = document.createElement("span");
    signal.className = "signal";
    signal.textContent = device.rssi == null ? "RSSI --" : `RSSI ${device.rssi}`;
    header.append(name, signal);

    const address = document.createElement("code");
    address.textContent = device.address;
    const service = document.createElement("span");
    service.className = "service-badge";
    service.textContent = device.targetService
      ? "广播含目标服务"
      : device.nameMatchesRing
        ? "名称匹配 ring"
        : "未发现目标服务";
    const button = document.createElement("button");
    button.className = "button primary wide";
    button.textContent = "连接设备";
    button.addEventListener("click", async () => {
      setBusy(button, true, "连接中（最长 20 秒）...");
      try {
        await bridgeClient.connect(device.address);
      } catch (error) {
        recordError(error, `连接 ${device.address}`);
        showToast(error.message || "连接失败", true);
      } finally {
        setBusy(button, false);
        button.disabled = bridgeClient.connected;
      }
    });
    card.append(header, address, service, button);
    list.append(card);
  }
}

async function scanDevices() {
  const button = $("scanButton");
  setBusy(button, true, "扫描中...");
  $("nearbyList").innerHTML = '<div class="nearby-empty">正在扫描附近 BLE 广播...</div>';
  try {
    const devices = await bridgeClient.scan({
      timeoutS: 5,
      targetOnly: $("targetOnlyToggle").checked,
    });
    renderNearbyDevices(devices);
    logSystem(`BLE 扫描完成，发现 ${devices.length} 个设备`);
  } catch (error) {
    recordError(error, "扫描附近设备");
    renderNearbyDevices([]);
    showToast(error.message || "扫描失败", true);
  } finally {
    setBusy(button, false);
  }
}

function updateConnectionMode() {
  const mode = $("connectionMode").value;
  client = mode === "bridge" ? bridgeClient : webClient;
  $("nearbyPanel").hidden = mode !== "bridge";
  $("chunkSize").disabled = mode === "bridge";
  $("timeSyncToggle").disabled = mode === "bridge";
  $("browserWarning").hidden = mode !== "web" || Boolean(navigator.bluetooth);
  const button = $("connectButton");
  button.textContent = mode === "bridge" ? "扫描设备" : "连接戒指";
  button.dataset.label = button.textContent;
  setConnected(client.connected, client.device?.name || client.device?.address || "");
  logSystem(`连接方式切换为${mode === "bridge" ? "本地 Python 桥接" : "浏览器 Web Bluetooth"}`);
}

$("scanButton").addEventListener("click", scanDevices);
$("connectionMode").addEventListener("change", async () => {
  if (client.connected) await client.disconnect();
  updateConnectionMode();
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

async function initialise() {
  setConnected(false);
  renderErrors();
  bridgeAvailable = await RingBridgeClient.available();
  const bridgeOption = $("connectionMode").querySelector('option[value="bridge"]');
  if (!bridgeAvailable) {
    bridgeOption.disabled = true;
    $("connectionMode").value = "web";
    $("bridgeHint").textContent =
      "本地桥接服务未运行，当前只能使用浏览器 Web Bluetooth 直连。";
    logSystem("未检测到 Python BLE 桥接服务，使用浏览器直连模式");
  } else {
    $("connectionMode").value = "bridge";
    logSystem("Python BLE 桥接服务已就绪，可扫描名称、MAC 和 RSSI");
  }
  updateConnectionMode();
  logSystem("Ring Sound Web Lab ready / protocol v4");
}

initialise().catch((error) => recordError(error, "页面初始化"));

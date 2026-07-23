# Ring Sound Web Lab

语音戒指测试页，支持两种连接方式：

- 本地 Python 桥接：使用 `bleak` 扫描，可显示广播名称、真实 MAC 地址、RSSI 和服务 UUID。
- 浏览器直连：使用 Web Bluetooth，不需要后端，但浏览器不会暴露真实 MAC 和扫描 RSSI。

## 启动

安装 Python 依赖：

```powershell
cd F:\ring_sound_SDK\web-test
python -m pip install -r requirements.txt
```

启动 BLE 桥接服务：

```powershell
python backend.py
```

打开：

```text
http://localhost:8765
```

默认使用“本地桥接”模式。点击“扫描 5 秒”后，页面会列出附近戒指的名称、MAC 和
RSSI，选择目标设备即可连接。

如需纯浏览器连接，可以把“连接方式”切换为“浏览器直连”。

## 当前功能

- BLE/NUS 扫描、连接和断开
- 广播名称、MAC 地址、RSSI 和目标服务显示
- v4 协议包重组与 CRC16 校验
- 自动响应 `0x0401` 校时请求
- 系统信息和设备存储
- 录音数量查询
- Quick 录音下载和缺帧补传
- 接收录音保存后的自动 `0x0505` 上报
- 原始 `.bin` 保存
- 实时 IMU 开启、停止和数据展示
- 普通双击、HMM 手势、按键单双击事件
- 日志空间和日志分块读取
- 协议收发控制台与导出

## 使用限制

- 戒指启动后默认处于录音模式。实时 IMU 前需要先单击戒指切换到手势模式。
- 当前协议不能查询或主动切换录音/手势模式。
- 自动录音接收和指定录音下载不能同时运行，它们会消费同一个 `0x0505` 数据流。
- 浏览器保存的是设备原始长度前缀 Speex `.bin`。需要 WAV 时，使用上级目录的
  `ring_sound.py audio-decode` 或其他 ffmpeg 解码流程。
- 浏览器直连模式下，20 字节写入分片兼容性最好。Python 桥接模式会由 bleak 处理分片。

## 测试

协议核心测试不需要戒指：

```powershell
cd F:\ring_sound_SDK\web-test
npm test
```

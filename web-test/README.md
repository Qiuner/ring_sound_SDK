# Ring Sound Web Lab

语音戒指 Web Bluetooth 测试页。页面由浏览器直接连接戒指，不需要 Python 后端。

## 启动

在目录中启动任意静态文件服务器，例如：

```powershell
cd F:\ring_sound_SDK\web-test
python -m http.server 8765
```

使用桌面 Chrome 或 Edge 打开：

```text
http://localhost:8765
```

点击“连接戒指”，在浏览器设备选择器中选择名称以 `ring` 或 `Ring` 开头的设备。

## 当前功能

- Web Bluetooth BLE/NUS 连接和断开
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
- 20 字节写入分片兼容性最好。

## 测试

协议核心测试不需要戒指：

```powershell
cd F:\ring_sound_SDK\web-test
npm test
```

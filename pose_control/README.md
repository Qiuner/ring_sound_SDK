# YOLO26n-pose INT8 CoreML 手臂方向控制

适用于 Apple Silicon Mac。模型输入为 640×640，支持单摄像头多人骨架识别。
在 Apple M4 上实测 CoreML 推理约 7～9 ms，实时窗口约 80 FPS。

程序默认使用镜像画面，跟踪主体人物手腕相对肩膀中心的短时位移，并输出：

- 画面 `+X`：`RIGHT`
- 画面 `-X`：`LEFT`
- 画面 `-Y`：`UP`
- 画面 `+Y`：`DOWN`

Z 轴不参与方向判断。斜向动作会被拒绝，避免强制输出错误方向。

## 安装

建议使用 Python 3.9～3.12：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements_yolo.txt
```

## 运行摄像头

```bash
python yolo_pose_camera.py
```

默认同时跟踪两只手腕，并选择短时间内移动最明显的一只。只跟踪佩戴戒指的手：

```bash
python yolo_pose_camera.py --hand right
python yolo_pose_camera.py --hand left
```

如果不需要镜像：

```bash
python yolo_pose_camera.py --no-mirror
```

按 `Q` 或 `Esc` 退出。

方向太难触发时可降低移动比例，例如：

```bash
python yolo_pose_camera.py --movement-ratio 0.20
```

## 测试视频

```bash
python yolo_pose_camera.py --source /path/to/video.mp4
```

## 重新导出模型

压缩包已经包含可直接运行的 `yolo26n-pose.mlpackage`。如需重新导出：

```bash
python export_yolo_coreml.py
```

Ultralytics YOLO 默认采用 AGPL-3.0；闭源商业产品上线前需确认相应商业许可。

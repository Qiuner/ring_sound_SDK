#!/usr/bin/env python3
"""Download YOLO26n-pose and export an INT8 CoreML model."""

from pathlib import Path

from ultralytics import YOLO


def main() -> None:
    root = Path(__file__).resolve().parent
    source = root / "yolo26n-pose.pt"
    model = YOLO(str(source))
    exported = model.export(format="coreml", imgsz=640, quantize=8)
    print(f"CoreML model ready: {exported}")


if __name__ == "__main__":
    main()

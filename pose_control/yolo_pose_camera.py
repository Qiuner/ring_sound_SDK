#!/usr/bin/env python3
"""Real-time multi-person pose demo using YOLO26n-pose INT8 CoreML."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

from direction_detector import ArmDirectionDetector


ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = ROOT / "yolo26n-pose.mlpackage"
LEFT_SHOULDER = 5
RIGHT_SHOULDER = 6
LEFT_WRIST = 9
RIGHT_WRIST = 10

ARROW_VECTORS = {
    "UP": (0, -1),
    "DOWN": (0, 1),
    "LEFT": (-1, 0),
    "RIGHT": (1, 0),
}


def parse_source(value: str) -> int | str:
    return int(value) if value.isdigit() else value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="30+ FPS multi-person pose detection on Apple Silicon."
    )
    parser.add_argument(
        "--source",
        default="0",
        help="Camera index (default: 0) or video file path.",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help="CoreML .mlpackage path.",
    )
    parser.add_argument("--confidence", type=float, default=0.25)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--max-people", type=int, default=20)
    mirror_group = parser.add_mutually_exclusive_group()
    mirror_group.add_argument(
        "--mirror",
        dest="mirror",
        action="store_true",
        default=True,
        help="Mirror the preview and direction output (default).",
    )
    mirror_group.add_argument(
        "--no-mirror",
        dest="mirror",
        action="store_false",
        help="Use the camera view without mirroring.",
    )
    parser.add_argument(
        "--hand",
        choices=("auto", "left", "right"),
        default="auto",
        help="Track either wrist or one selected wrist (default: auto).",
    )
    parser.add_argument("--keypoint-confidence", type=float, default=0.35)
    parser.add_argument(
        "--movement-ratio",
        type=float,
        default=0.28,
        help="Required wrist movement relative to shoulder width.",
    )
    return parser


def primary_pose(result: object, confidence: float) -> tuple[dict[str, tuple[float, float]], float]:
    """Return wrist coordinates relative to the shoulder center."""
    if result.keypoints is None or result.boxes is None or len(result.boxes) == 0:
        return {}, 1.0

    boxes = result.boxes.xyxy.cpu().numpy()
    areas = np.maximum(0, boxes[:, 2] - boxes[:, 0]) * np.maximum(
        0, boxes[:, 3] - boxes[:, 1]
    )
    person_index = int(np.argmax(areas))
    points = result.keypoints.xy[person_index].cpu().numpy()
    point_confidence = result.keypoints.conf
    if point_confidence is None:
        scores = np.ones(len(points), dtype=np.float32)
    else:
        scores = point_confidence[person_index].cpu().numpy()

    required = (LEFT_SHOULDER, RIGHT_SHOULDER)
    if any(scores[index] < confidence for index in required):
        return {}, 1.0

    left_shoulder = points[LEFT_SHOULDER]
    right_shoulder = points[RIGHT_SHOULDER]
    shoulder_center = (left_shoulder + right_shoulder) / 2
    shoulder_width = float(np.linalg.norm(left_shoulder - right_shoulder))
    wrists: dict[str, tuple[float, float]] = {}
    for hand, index in (("left", LEFT_WRIST), ("right", RIGHT_WRIST)):
        if scores[index] >= confidence:
            relative = points[index] - shoulder_center
            wrists[hand] = (float(relative[0]), float(relative[1]))
    return wrists, max(shoulder_width, 1.0)


def draw_direction(output: np.ndarray, direction: str, confidence: float) -> None:
    height, width = output.shape[:2]
    center = (width // 2, max(110, height // 5))
    vector = ARROW_VECTORS[direction]
    arrow_length = max(60, min(width, height) // 7)
    end = (
        center[0] + vector[0] * arrow_length,
        center[1] + vector[1] * arrow_length,
    )
    cv2.arrowedLine(output, center, end, (0, 255, 255), 10, cv2.LINE_AA, tipLength=0.35)
    label = f"{direction}  {confidence * 100:.0f}%"
    text_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 1.25, 3)[0]
    cv2.putText(
        output,
        label,
        ((width - text_size[0]) // 2, center[1] + arrow_length + 55),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.25,
        (0, 255, 255),
        3,
        cv2.LINE_AA,
    )


def main() -> int:
    args = build_parser().parse_args()
    source = parse_source(args.source)

    if not args.model.exists():
        raise SystemExit(
            f"CoreML model not found: {args.model}\n"
            "Run: python export_yolo_coreml.py"
        )
    if isinstance(source, str) and not Path(source).exists():
        raise SystemExit(f"Video not found: {source}")

    model = YOLO(str(args.model), task="pose")

    # Compile and warm up CoreML before opening the live preview.
    warmup = np.zeros((640, 640, 3), dtype=np.uint8)
    model.predict(warmup, imgsz=640, conf=args.confidence, verbose=False)

    capture = cv2.VideoCapture(source)
    if isinstance(source, int):
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    if not capture.isOpened():
        raise SystemExit(
            "Cannot open camera/video. Allow camera access for Codex or Terminal "
            "in macOS Settings > Privacy & Security > Camera."
        )

    smoothed_fps = 0.0
    direction_detector = ArmDirectionDetector(movement_ratio=args.movement_ratio)
    last_direction: tuple[str, float] | None = None
    last_direction_until = 0.0
    print(
        "YOLO pose arm direction is running in "
        f"{'MIRROR' if args.mirror else 'CAMERA'} mode. Press Q or Esc to quit."
    )

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if args.mirror:
                frame = cv2.flip(frame, 1)

            started = time.perf_counter()
            result = model.predict(
                frame,
                imgsz=640,
                conf=args.confidence,
                max_det=args.max_people,
                verbose=False,
            )[0]
            output = result.plot(
                img=frame,
                boxes=False,
                labels=False,
                conf=False,
                line_width=2,
            )
            elapsed = max(time.perf_counter() - started, 1e-6)
            current_fps = 1.0 / elapsed
            smoothed_fps = (
                current_fps
                if smoothed_fps == 0
                else smoothed_fps * 0.9 + current_fps * 0.1
            )

            inference_ms = float(result.speed.get("inference", 0.0))
            people = len(result.boxes)
            wrists, body_scale = primary_pose(result, args.keypoint_confidence)
            if args.hand != "auto":
                wrists = {
                    hand: point
                    for hand, point in wrists.items()
                    if hand == args.hand
                }
            event = direction_detector.update(
                time.perf_counter(),
                wrists,
                body_scale,
            )
            if event is not None:
                last_direction = (event.direction, event.confidence)
                last_direction_until = time.perf_counter() + 0.8
                print(
                    f"{event.direction} | hand={event.hand} "
                    f"| confidence={event.confidence:.2f} "
                    f"| dx={event.dx:.1f} dy={event.dy:.1f}"
                )

            cv2.putText(
                output,
                (
                    f"people {people} | total {smoothed_fps:.1f} FPS"
                    f" | CoreML {inference_ms:.1f} ms"
                ),
                (16, 34),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.72,
                (40, 255, 40),
                2,
                cv2.LINE_AA,
            )
            cv2.putText(
                output,
                (
                    f"direction: MIRROR | hand: {args.hand}"
                    if args.mirror
                    else f"direction: CAMERA | hand: {args.hand}"
                ),
                (16, 66),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.64,
                (0, 255, 255),
                2,
                cv2.LINE_AA,
            )
            if last_direction is not None and time.perf_counter() < last_direction_until:
                draw_direction(output, last_direction[0], last_direction[1])
            cv2.imshow("YOLO26n-pose INT8 CoreML", output)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
    finally:
        capture.release()
        cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

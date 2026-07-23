"""Short-window arm direction detection from pose-relative wrist coordinates."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math


@dataclass(frozen=True)
class DirectionEvent:
    direction: str
    hand: str
    dx: float
    dy: float
    confidence: float


class ArmDirectionDetector:
    """Detect one dominant wrist movement in mirrored screen coordinates.

    Input wrist coordinates must already be relative to the shoulder center so
    whole-body translation does not look like an arm gesture. Image Y increases
    downward; therefore negative dy is UP and positive dy is DOWN.
    """

    def __init__(
        self,
        *,
        window_seconds: float = 0.35,
        minimum_duration_seconds: float = 0.10,
        movement_ratio: float = 0.28,
        minimum_pixels: float = 28.0,
        dominance_ratio: float = 1.25,
        cooldown_seconds: float = 0.45,
    ) -> None:
        self.window_seconds = max(0.1, float(window_seconds))
        self.minimum_duration_seconds = max(0.03, float(minimum_duration_seconds))
        self.movement_ratio = max(0.05, float(movement_ratio))
        self.minimum_pixels = max(1.0, float(minimum_pixels))
        self.dominance_ratio = max(1.0, float(dominance_ratio))
        self.cooldown_seconds = max(0.0, float(cooldown_seconds))
        self._history: dict[str, deque[tuple[float, float, float]]] = {
            "left": deque(),
            "right": deque(),
        }
        self._cooldown_until = 0.0

    def reset(self) -> None:
        for history in self._history.values():
            history.clear()
        self._cooldown_until = 0.0

    def update(
        self,
        timestamp: float,
        wrists: dict[str, tuple[float, float]],
        body_scale: float,
    ) -> DirectionEvent | None:
        now = float(timestamp)
        scale = max(1.0, float(body_scale))
        cutoff = now - self.window_seconds

        for hand, history in self._history.items():
            point = wrists.get(hand)
            if point is not None:
                history.append((now, float(point[0]), float(point[1])))
            while history and history[0][0] < cutoff:
                history.popleft()

        if now < self._cooldown_until:
            return None

        candidates: list[tuple[float, str, float, float]] = []
        threshold = max(self.minimum_pixels, scale * self.movement_ratio)
        for hand, history in self._history.items():
            if len(history) < 2:
                continue
            started_at, start_x, start_y = history[0]
            ended_at, end_x, end_y = history[-1]
            if ended_at - started_at < self.minimum_duration_seconds:
                continue
            dx = end_x - start_x
            dy = end_y - start_y
            distance = math.hypot(dx, dy)
            if distance >= threshold:
                candidates.append((distance, hand, dx, dy))

        if not candidates:
            return None

        distance, hand, dx, dy = max(candidates)
        horizontal = abs(dx)
        vertical = abs(dy)
        strongest = max(horizontal, vertical)
        secondary = min(horizontal, vertical)
        if strongest / max(1.0, secondary) < self.dominance_ratio:
            return None

        if horizontal > vertical:
            direction = "RIGHT" if dx > 0 else "LEFT"
        else:
            direction = "DOWN" if dy > 0 else "UP"

        confidence = min(
            1.0,
            0.55 * min(1.0, distance / max(threshold * 2.0, 1.0))
            + 0.45 * min(1.0, strongest / max(secondary * 2.0, 1.0)),
        )
        self._cooldown_until = now + self.cooldown_seconds
        for history in self._history.values():
            if history:
                history_entry = history[-1]
                history.clear()
                history.append(history_entry)

        return DirectionEvent(
            direction=direction,
            hand=hand,
            dx=dx,
            dy=dy,
            confidence=confidence,
        )

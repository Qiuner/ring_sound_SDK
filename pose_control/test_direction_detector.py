import unittest

from direction_detector import ArmDirectionDetector


class ArmDirectionDetectorTests(unittest.TestCase):
    def make_detector(self) -> ArmDirectionDetector:
        return ArmDirectionDetector(
            movement_ratio=0.2,
            minimum_pixels=10,
            cooldown_seconds=0,
        )

    def test_mirrored_right_and_left(self) -> None:
        detector = self.make_detector()
        self.assertIsNone(detector.update(0.0, {"right": (0, 0)}, 100))
        event = detector.update(0.2, {"right": (35, 2)}, 100)
        self.assertEqual(event.direction, "RIGHT")

        detector.reset()
        detector.update(0.0, {"left": (0, 0)}, 100)
        event = detector.update(0.2, {"left": (-35, -2)}, 100)
        self.assertEqual(event.direction, "LEFT")

    def test_image_y_maps_to_up_and_down(self) -> None:
        detector = self.make_detector()
        detector.update(0.0, {"right": (0, 0)}, 100)
        event = detector.update(0.2, {"right": (1, -35)}, 100)
        self.assertEqual(event.direction, "UP")

        detector.reset()
        detector.update(0.0, {"right": (0, 0)}, 100)
        event = detector.update(0.2, {"right": (-1, 35)}, 100)
        self.assertEqual(event.direction, "DOWN")

    def test_diagonal_motion_is_rejected(self) -> None:
        detector = self.make_detector()
        detector.update(0.0, {"right": (0, 0)}, 100)
        event = detector.update(0.2, {"right": (30, 28)}, 100)
        self.assertIsNone(event)


if __name__ == "__main__":
    unittest.main()

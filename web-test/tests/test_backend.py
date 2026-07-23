import asyncio
import unittest

import backend


class HangingClient:
    disconnected = False

    def __init__(self, *args, **kwargs):
        self.is_connected = False

    def add_packet_handler(self, command, handler):
        pass

    async def connect(self):
        await asyncio.Event().wait()

    async def disconnect(self):
        self.disconnected = True


class BridgeConnectTests(unittest.IsolatedAsyncioTestCase):
    async def test_connect_timeout_becomes_sdk_timeout_error(self):
        service = backend.BridgeService(
            client_factory=HangingClient,
            connect_timeout_s=0.01,
        )
        with self.assertRaises(backend.sdk.TimeoutError):
            await service.connect("D3:AF:5B:12:2B:B9")


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextlib import suppress
import json
from pathlib import Path
import sys
from typing import Any

from bleak import BleakScanner
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import uvicorn


ROOT = Path(__file__).resolve().parent
SDK_ROOT = ROOT.parent
if str(SDK_ROOT) not in sys.path:
    sys.path.insert(0, str(SDK_ROOT))

import ring_sound as sdk  # noqa: E402


NUS_SERVICE_UUID = sdk.NUS_SERVICE_UUID.lower()
KNOWN_COMMANDS = sorted(
    {
        int(value)
        for enum_type in (
            sdk.SystemCommand,
            sdk.LogCommand,
            sdk.TimeCommand,
            sdk.AudioCommand,
            sdk.SensorCommand,
        )
        for value in enum_type
    }
)


def bytes_from_hex(value: str | None) -> bytes:
    text = "".join(str(value or "").split())
    if not text:
        return b""
    try:
        return bytes.fromhex(text)
    except ValueError as exc:
        raise sdk.ProtocolError(f"Invalid body_hex: {exc}") from exc


def packet_json(packet: sdk.Packet) -> dict[str, Any]:
    return {
        "command": packet.command,
        "bodyHex": packet.body.hex(),
        "version": packet.version,
        "bodyCrc": packet.body_crc,
    }


class BridgeRingClient(sdk.RingSoundClient):
    def __init__(self, *args: Any, disconnect_callback: Any = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._bridge_disconnect_callback = disconnect_callback

    def _on_disconnect(self) -> None:
        was_connected = not self._disconnected.is_set()
        super()._on_disconnect()
        if was_connected and self._bridge_disconnect_callback:
            self._bridge_disconnect_callback()


class BridgeService:
    def __init__(
        self,
        *,
        client_factory: Any = BridgeRingClient,
        connect_timeout_s: float = 20.0,
    ) -> None:
        self.client_factory = client_factory
        self.connect_timeout_s = connect_timeout_s
        self.client: BridgeRingClient | None = None
        self.device_name: str | None = None
        self.device_address: str | None = None
        self.scan_cache: dict[str, dict[str, Any]] = {}
        self.subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self.connection_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return bool(self.client and self.client.is_connected)

    def publish(self, payload: dict[str, Any]) -> None:
        for queue in list(self.subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(payload)

    def publish_wire(self, direction: str, command: int, packet_bytes: bytes) -> None:
        self.publish(
            {
                "kind": "wire",
                "direction": direction,
                "command": command,
                "bytesHex": packet_bytes.hex(),
            }
        )

    def handle_packet(self, packet: sdk.Packet) -> None:
        self.publish_wire("rx", packet.command, sdk.encode_packet(packet.command, packet.body))
        self.publish({"kind": "packet", **packet_json(packet)})

    def handle_disconnect(self) -> None:
        self.publish({"kind": "disconnected"})

    async def scan(self, timeout_s: float = 5.0, target_only: bool = True) -> list[dict[str, Any]]:
        if self.connected:
            raise sdk.TransportError("Disconnect the current ring before scanning")
        discovered = await BleakScanner.discover(
            timeout=max(1.0, min(float(timeout_s), 20.0)),
            return_adv=True,
        )
        results: list[dict[str, Any]] = []
        for device, advertisement in discovered.values():
            service_uuids = [str(item).lower() for item in advertisement.service_uuids or []]
            has_target_service = NUS_SERVICE_UUID in service_uuids
            name = advertisement.local_name or device.name or "Unknown"
            name_matches_ring = "ring" in name.lower()
            if target_only and not (has_target_service or name_matches_ring):
                continue
            item = {
                "name": name,
                "address": str(device.address),
                "rssi": advertisement.rssi,
                "targetService": has_target_service,
                "nameMatchesRing": name_matches_ring,
                "serviceUuids": service_uuids,
            }
            results.append(item)
            self.scan_cache[item["address"].lower()] = item
        results.sort(
            key=lambda item: (
                not item["targetService"],
                -(item["rssi"] if item["rssi"] is not None else -999),
            )
        )
        return results

    async def connect(self, address: str) -> dict[str, Any]:
        async with self.connection_lock:
            if self.connected:
                await self._disconnect_unlocked()
            client = self.client_factory(
                address=address,
                disconnect_callback=self.handle_disconnect,
            )
            for command in KNOWN_COMMANDS:
                client.add_packet_handler(command, self.handle_packet)
            try:
                await asyncio.wait_for(
                    client.connect(),
                    timeout=max(0.01, float(self.connect_timeout_s)),
                )
            except asyncio.TimeoutError as exc:
                with suppress(Exception):
                    await asyncio.wait_for(client.disconnect(), timeout=3.0)
                raise sdk.TimeoutError(
                    f"BLE 连接在 {self.connect_timeout_s:g} 秒内未完成。"
                    "请关闭其他已连接的手机或浏览器、确认戒指仍在广播，然后重试"
                ) from exc
            except Exception:
                with suppress(Exception):
                    await asyncio.wait_for(client.disconnect(), timeout=3.0)
                raise
            sdk.enable_time_sync(client)
            cached = self.scan_cache.get(address.lower(), {})
            self.client = client
            self.device_address = address
            self.device_name = cached.get("name") or address
            detail = {
                "name": self.device_name,
                "address": self.device_address,
                "rssi": cached.get("rssi"),
            }
            self.publish({"kind": "connected", "device": detail})
            return detail

    async def disconnect(self) -> None:
        async with self.connection_lock:
            await self._disconnect_unlocked()

    async def _disconnect_unlocked(self) -> None:
        client = self.client
        self.client = None
        self.device_name = None
        self.device_address = None
        if client:
            await client.disconnect()
        self.publish({"kind": "disconnected"})

    def require_client(self) -> BridgeRingClient:
        if not self.client or not self.client.is_connected:
            raise sdk.TransportError("BLE client is not connected")
        return self.client

    async def send(self, command: int, body: bytes) -> None:
        client = self.require_client()
        self.publish_wire("tx", command, sdk.encode_packet(command, body))
        await client.send_command(command, body)

    async def request(
        self,
        command: int,
        response_command: int,
        body: bytes,
        timeout_s: float | None,
    ) -> sdk.Packet:
        client = self.require_client()
        self.publish_wire("tx", command, sdk.encode_packet(command, body))
        return await client.request(
            command,
            response_command,
            body,
            timeout_s=timeout_s,
        )

    async def wait(self, command: int, timeout_s: float | None) -> sdk.Packet:
        return await self.require_client().wait_for_command(command, timeout_s=timeout_s)

    def drain(self, command: int) -> None:
        self.require_client()._drain_queue(command)

    async def close(self) -> None:
        if self.client:
            await self.disconnect()


bridge = BridgeService()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await bridge.close()


app = FastAPI(title="Ring Sound BLE Bridge", lifespan=lifespan)


@app.exception_handler(sdk.RingSoundError)
async def ring_error_handler(_request: Request, exc: sdk.RingSoundError) -> JSONResponse:
    payload: dict[str, Any] = {
        "type": type(exc).__name__,
        "message": str(exc),
    }
    if isinstance(exc, sdk.DeviceError):
        payload["errorCode"] = exc.error_code
    return JSONResponse(status_code=400, content={"detail": payload})


@app.exception_handler(Exception)
async def unexpected_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "type": type(exc).__name__,
                "message": str(exc),
            }
        },
    )


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "sdkVersion": sdk.__version__,
        "connected": bridge.connected,
        "bleak": True,
    }


@app.get("/api/status")
async def status() -> dict[str, Any]:
    return {
        "connected": bridge.connected,
        "device": {
            "name": bridge.device_name,
            "address": bridge.device_address,
        }
        if bridge.connected
        else None,
    }


@app.post("/api/scan")
async def scan(request: Request) -> dict[str, Any]:
    body = await request.json()
    devices = await bridge.scan(
        timeout_s=float(body.get("timeoutS", 5.0)),
        target_only=bool(body.get("targetOnly", True)),
    )
    return {"devices": devices}


@app.post("/api/connect")
async def connect(request: Request) -> dict[str, Any]:
    body = await request.json()
    address = str(body.get("address") or "").strip()
    if not address:
        raise sdk.TransportError("BLE address is required")
    return {"device": await bridge.connect(address)}


@app.post("/api/disconnect")
async def disconnect() -> dict[str, bool]:
    await bridge.disconnect()
    return {"ok": True}


@app.post("/api/send")
async def send(request: Request) -> dict[str, bool]:
    body = await request.json()
    await bridge.send(int(body["command"]), bytes_from_hex(body.get("bodyHex")))
    return {"ok": True}


@app.post("/api/request")
async def command_request(request: Request) -> dict[str, Any]:
    body = await request.json()
    packet = await bridge.request(
        int(body["command"]),
        int(body["responseCommand"]),
        bytes_from_hex(body.get("bodyHex")),
        float(body["timeoutMs"]) / 1000 if body.get("timeoutMs") is not None else None,
    )
    return {"packet": packet_json(packet)}


@app.post("/api/wait")
async def wait(request: Request) -> dict[str, Any]:
    body = await request.json()
    packet = await bridge.wait(
        int(body["command"]),
        float(body["timeoutMs"]) / 1000 if body.get("timeoutMs") is not None else None,
    )
    return {"packet": packet_json(packet)}


@app.post("/api/drain")
async def drain(request: Request) -> dict[str, bool]:
    body = await request.json()
    bridge.drain(int(body["command"]))
    return {"ok": True}


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
    bridge.subscribers.add(queue)

    async def stream():
        try:
            yield f"data: {json.dumps({'kind': 'ready'})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            bridge.subscribers.discard(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


app.mount("/", StaticFiles(directory=ROOT, html=True), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")

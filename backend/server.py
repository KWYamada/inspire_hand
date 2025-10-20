# server.py
import asyncio, json, time
from typing import List, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Body
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from inspire_hand import InspireHand  # your class

hand = InspireHand(port="/dev/ttyCH341USB0", baudrate=115200, slave_id=1, debug=False)

subscribers: Set[WebSocket] = set()
telemetry_period = 0.2  # 5 Hz push to clients
manual_speed = 600      # 0..1000

def clamp(v, lo=0, hi=1000):
    try:
        return max(lo, min(hi, int(v)))
    except Exception:
        return lo

# --------- LATEST-ONLY MAILBOX (capacity=1) ---------
class LatestOnly:
    def __init__(self):
        self._item = None
        self._event = asyncio.Event()
        self._lock = asyncio.Lock()

    async def put(self, item):
        async with self._lock:
            self._item = item
            self._event.set()

    async def get(self, timeout=None):
        if timeout is not None:
            try:
                await asyncio.wait_for(self._event.wait(), timeout)
            except asyncio.TimeoutError:
                return None
        else:
            await self._event.wait()
        async with self._lock:
            it = self._item
            self._item = None
            self._event.clear()
            return it

desired_angles = LatestOnly()

# --------- DRIVER: the ONLY place that touches Modbus ---------
async def driver_loop():
    """
    Runs at a fixed cadence; coalesces to the latest angles and
    performs ONE batched write per tick in a worker thread.
    """
    # safe, conservative device rate (10 Hz)
    period = 0.10  # seconds
    last_sent = None

    while True:
        t0 = time.monotonic()
        # get latest desired angles if any, else reuse last
        latest = await desired_angles.get(timeout=period)
        target = latest if latest is not None else last_sent

        if target is not None:
            # clamp and send as a single multi-register write
            arr = [clamp(x) for x in target[:6]]
            try:
                # write ANGLE_SET block (base 1486) in one go
                # run in thread so the event loop stays responsive
                await asyncio.to_thread(hand.modbus.write_multiple_registers, 1486, arr)
                last_sent = arr
            except Exception as e:
                print("[driver] write failed:", e, flush=True)

        # finish tick
        dt = time.monotonic() - t0
        await asyncio.sleep(max(0.0, period - dt))

# --------- TELEMETRY: also offloaded to threads ---------
async def telemetry_loop():
    global telemetry_period
    while True:
        await asyncio.sleep(telemetry_period)
        if not subscribers or not hand.is_connected:
            continue
        try:
            forces = await asyncio.to_thread(hand.get_finger_forces)
            temps  = await asyncio.to_thread(hand.get_finger_temperatures)
            status = await asyncio.to_thread(lambda: list(map(int, hand.get_finger_statuses())))
            angles = await asyncio.to_thread(hand.get_finger_angles)
            payload = {
                "telemetry": {
                    "t": time.time(),
                    "forces": forces,
                    "temps": temps,
                    "status": status,
                    "angles": angles,
                    "speed": manual_speed,
                }
            }
            dead = []
            for ws in list(subscribers):
                try:
                    await ws.send_text(json.dumps(payload))
                except Exception:
                    dead.append(ws)
            for ws in dead:
                subscribers.discard(ws)
        except Exception as e:
            print("[telemetry] error:", e, flush=True)

# ------------------ lifespan ------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # startup
    hand.open()
    hand.set_all_finger_speeds(manual_speed)
    hand.set_all_finger_forces(500)
    print("[startup] hand connected", flush=True)

    # start background tasks
    drv = asyncio.create_task(driver_loop())
    tel = asyncio.create_task(telemetry_loop())
    try:
        yield
    finally:
        for task in (drv, tel):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if hand.is_connected:
            hand.close()
        print("[shutdown] hand disconnected", flush=True)

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------ routes ------------------
@app.post("/api/angles")
async def post_angles(payload: dict = Body(...)):
    angles = payload.get("angles")
    if isinstance(angles, list) and len(angles) == 6:
        # do NOT write here; just update desired state
        await desired_angles.put(angles)
        return {"ok": True}
    return {"ok": False, "error": "need 6 angles"}

@app.websocket("/ws")
async def ws_angles(ws: WebSocket):
    await ws.accept()
    subscribers.add(ws)
    try:
        while True:
            data = json.loads(await ws.receive_text())

            if "angles" in data:
                angles = data["angles"]
                if isinstance(angles, list) and len(angles) == 6:
                    # do NOT write here
                    await desired_angles.put(angles)
                    # (optional) no echo to avoid backpressure
                else:
                    await ws.send_text('{"ok":false,"error":"need 6 angles"}')

            elif data.get("cmd") == "set_speed":
                global manual_speed
                manual_speed = clamp(data.get("value", 600))
                try:
                    await asyncio.to_thread(hand.set_all_finger_speeds, manual_speed)
                except Exception as e:
                    await ws.send_text(json.dumps({"ok": False, "error": str(e)}))
                else:
                    await ws.send_text(json.dumps({"ok": True, "speed": manual_speed}))

            elif data.get("cmd") == "set_telemetry_rate_hz":
                global telemetry_period
                try:
                    hz = float(data.get("value", 5.0))
                except Exception:
                    hz = 5.0
                hz = max(0.5, min(50.0, hz))
                telemetry_period = 1.0 / hz
                await ws.send_text(json.dumps({"ok": True, "telemetry_hz": hz}))

            elif data.get("cmd") == "estop":
                await asyncio.to_thread(hand.set_all_finger_speeds, 0)
                await ws.send_text('{"ok":true,"estop":true}')

            elif data.get("cmd") == "open":
                await asyncio.to_thread(hand.open_all_fingers)
                await ws.send_text('{"ok":true}')

            elif data.get("cmd") == "close":
                await asyncio.to_thread(hand.close_all_fingers)
                await ws.send_text('{"ok":true}')

            else:
                await ws.send_text('{"ok":false,"error":"unknown message"}')

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print("[WS] error:", e, flush=True)
    finally:
        subscribers.discard(ws)
        try:
            await ws.close()
        except Exception:
            pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)

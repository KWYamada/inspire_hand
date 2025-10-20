# ws_bridge.py
import asyncio, json, websockets, httpx

BACKEND_HTTP = "http://192.168.100.142:8000/api/angles"

async def handler(ws):
    async with httpx.AsyncClient(timeout=1.0) as client:
        async for msg in ws:
            print("[WSBridge] Received:", msg)
            try:
                data = json.loads(msg)
                await client.post(BACKEND_HTTP, json=data)
                await ws.send(json.dumps({"ok": True}))
            except Exception as e:
                await ws.send(json.dumps({"ok": False, "error": str(e)}))

async def main():
    async with websockets.serve(handler, "192.168.100.142", 8765):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())

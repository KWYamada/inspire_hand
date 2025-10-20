import React, { useEffect, useRef, useState } from "react";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

// ---------- helpers ----------
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const names = ["Little", "Ring", "Middle", "Index", "Thumb Bend", "Thumb Rotate"];

function fingerCurl(landmarks, tipIdx, mcpIdx, wristIdx = 0) {
  const tip = landmarks[tipIdx];
  const mcp = landmarks[mcpIdx];
  const wrist = landmarks[wristIdx];
  const tipToMcp = distance(tip, mcp);
  const mcpToWrist = distance(mcp, wrist) + 1e-6;
  const ratio = tipToMcp / mcpToWrist;
  const curl = 1 - (ratio - 0.15) / (0.5 - 0.15);
  return clamp01(curl);
}
function emaVec(prev, next, alpha) {
  if (!prev || prev.length !== next.length) return next;
  return next.map((v, i) => lerp(prev[i], v, alpha));
}
const curlToAngle = (curl) => Math.round((1 - clamp01(curl)) * 1000);
const HAND_CONNECTIONS = [
  [0, 1],[1, 2],[2, 3],[3, 4],
  [0, 5],[5, 6],[6, 7],[7, 8],
  [5, 9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];
function drawHand(ctx, landmarks) {
  ctx.lineWidth = 2;
  HAND_CONNECTIONS.forEach(([i, j]) => {
    const a = landmarks[i], b = landmarks[j];
    ctx.beginPath();
    ctx.moveTo(a.x * ctx.canvas.width, a.y * ctx.canvas.height);
    ctx.lineTo(b.x * ctx.canvas.width, b.y * ctx.canvas.height);
    ctx.stroke();
  });
  landmarks.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x * ctx.canvas.width, p.y * ctx.canvas.height, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ---------- component ----------
export default function HandTeleop() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // WS + config
  const qs = new URLSearchParams(window.location.search);
  const BACKEND_HOST = qs.get("backend") || process.env.REACT_APP_BACKEND_HOST || window.location.hostname;
  const WS_PORT = qs.get("ws_port") || process.env.REACT_APP_WS_PORT || "8000";
  const WS_PATH = qs.get("ws_path") || "/ws";
  const WS_PROTO = window.location.protocol === "https:" ? "wss" : "ws";
  const WS_URL = `${WS_PROTO}://${BACKEND_HOST}:${WS_PORT}${WS_PATH}`;

  // UI / state
  const [status, setStatus] = useState("Idle");
  const [mode, setMode] = useState("teleop"); // "teleop" | "manual"
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Angles we send (Inspire order)
  const [angles, setAngles] = useState([1000,1000,1000,1000,1000,500]);

  // Teleop tuning
  const [teleopSmooth, setTeleopSmooth] = useState(0.35);

  // Manual streaming rate (Hz) & interval
  const [manualHz, setManualHz] = useState(10);
  const manualTimerRef = useRef(null);

  // Motion speed (0..1000)
  const [speed, setSpeed] = useState(600);

  // WS
  const wsRef = useRef(null);
  const [wsOpen, setWsOpen] = useState(false);

  // Telemetry
  const [forces, setForces] = useState([0,0,0,0,0,0]);
  const [temps, setTemps]   = useState([0,0,0,0,0,0]);
  const [statuses, setStatuses] = useState([0,0,0,0,0,0]);
  const [telemetryHz, setTelemetryHz] = useState(0);
  const telemetryLastRef = useRef(0);


  // Open WebSocket
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsOpen(true);
      setStatus((s) => s + " | WS connected");
      try { ws.send(JSON.stringify({ hello: true })); } catch {}
      // Ensure backend speed & telemetry rate match UI
      ws.send(JSON.stringify({ cmd: "set_speed", value: speed }));
      ws.send(JSON.stringify({ cmd: "set_telemetry_rate_hz", value: 5 })); // default 5 Hz
    };
    ws.onmessage = (e) => {
      const now = performance.now();
      try {
        const data = JSON.parse(e.data);
        if (data.telemetry) {
          const t = data.telemetry;
          if (Array.isArray(t.forces)) setForces(t.forces);
          if (Array.isArray(t.temps)) setTemps(t.temps);
          if (Array.isArray(t.status)) setStatuses(t.status);
          telemetryLastRef.current = now;
        }
      } catch {}
    };
    ws.onclose = () => { setWsOpen(false); setStatus((s) => s + " | WS closed"); };
    ws.onerror = () => { setStatus((s) => s + " | WS error"); };

    // monitor telemetry rate
    const r = setInterval(() => {
      const dt = performance.now() - telemetryLastRef.current;
      setTelemetryHz(dt > 0 ? +(1000 / dt).toFixed(1) : 0);
    }, 1000);

    return () => { clearInterval(r); ws.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [WS_URL]);

  // NEW: one client-side send cap for both modes
  const [clientHz, setClientHz] = useState(10); // default 10 Hz is safe
  const minGapRef = useRef(100);               // ms, derives from clientHz
  const lastSentAtRef = useRef(0);
  const pendingRef = useRef(null);
  const tickTimerRef = useRef(null);

  useEffect(() => {
    // update min gap whenever clientHz changes
    minGapRef.current = Math.max(20, Math.round(1000 / Math.max(1, Math.min(50, clientHz))));
  }, [clientHz]);

  // coalescing sender: keep only the latest command
  const flushSend = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    const gap = minGapRef.current;
    if (now - lastSentAtRef.current >= gap && pendingRef.current) {
      wsRef.current.send(JSON.stringify({ angles: pendingRef.current }));
      lastSentAtRef.current = now;
      pendingRef.current = null;
    }
    // keep ticking while there is pending work
    if (pendingRef.current) {
      tickTimerRef.current = setTimeout(flushSend, gap - (performance.now() - lastSentAtRef.current));
    } else {
      tickTimerRef.current = null;
    }
  };

  const sendAngles = (arr) => {
    pendingRef.current = arr;
    if (!tickTimerRef.current) flushSend();
  };

    // Keep angles in a ref so the timer doesn't need to depend on angles
  const anglesRef = useRef(angles);
  useEffect(() => { anglesRef.current = angles; }, [angles]);

  // Manual mode continuous streaming (client keepalive)
  // Uses the coalescing sendAngles(), so it won't exceed clientHz
  useEffect(() => {
    if (mode !== "manual") {
      if (manualTimerRef.current) clearInterval(manualTimerRef.current);
      manualTimerRef.current = null;
      return;
    }
    const periodMs = Math.max(20, Math.round(1000 / Math.max(1, Math.min(50, manualHz))));
    manualTimerRef.current = setInterval(() => {
      sendAngles(anglesRef.current);
    }, periodMs);
    return () => { if (manualTimerRef.current) clearInterval(manualTimerRef.current); };
  }, [mode, manualHz]); // <-- angles removed from deps

  const sendWS = (obj) => {
  const ws = wsRef.current;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

  // Change speed → push to backend
  useEffect(() => {
    if (wsOpen) sendWS({ cmd: "set_speed", value: Math.max(0, Math.min(1000, speed)) });
  }, [speed, wsOpen]);

  // Drawing + teleop pipeline
  const onResults = (results) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Mirror video
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (modeRef.current === "teleop") {
      const handsLm = results.multiHandLandmarks || [];
      const handed = results.multiHandedness || [];
      let left = null;
      for (let i = 0; i < handsLm.length; i++) {
        const label = handed[i]?.label;
        if (label === "Left") { left = handsLm[i]; break; }
      }
      if (left) {
        drawHand(ctx, left);
        const curlThumb = fingerCurl(left, 4, 2);
        const curlIndex = fingerCurl(left, 8, 5);
        const curlMiddle = fingerCurl(left, 12, 9);
        const curlRing  = fingerCurl(left, 16, 13);
        const curlPinky = fingerCurl(left, 20, 17);
        const target = [
          curlToAngle(curlPinky),
          curlToAngle(curlRing),
          curlToAngle(curlMiddle),
          curlToAngle(curlIndex),
          curlToAngle(curlThumb),
          500,
        ];
        let smoothed = emaVec(angles, target, teleopSmooth).map((v) => Math.round(v));
        setAngles(smoothed);
        sendAngles(smoothed);
      }
    }
    ctx.restore();
  };

  // Setup MediaPipe + camera (model runs only in teleop)
  useEffect(() => {
    let hands, camera;
    (async () => {
      try {
        setStatus("Loading MediaPipe...");
        hands = new Hands({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
        hands.onResults(onResults);

        if (!videoRef.current) return;
        camera = new Camera(videoRef.current, {
          onFrame: async () => {
            if (!videoRef.current) return;
            if (modeRef.current !== "teleop") return; // pause model in manual mode
            await hands.send({ image: videoRef.current });
          },
          width: 640,
          height: 480,
        });
        await camera.start();
        setStatus("Camera ready. Show your LEFT hand.");
      } catch (e) {
        console.error(e);
        setStatus(`Error: ${e?.message || e}`);
      }
    })();
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual sliders
  const setAngleIdx = (i, v) => {
    const next = [...angles];
    next[i] = v;
    setAngles(next);
    if (mode === "manual") sendAngles(next); // immediate send; interval will also keep it alive
  };

  // UI
  const hudDot = (ok) => (
    <span style={{
      display: "inline-block", width: 10, height: 10,
      borderRadius: 10, marginRight: 6,
      background: ok ? "#2ecc71" : "#e74c3c",
      boxShadow: ok ? "0 0 6px #2ecc71" : "0 0 6px #e74c3c"
    }} />
  );

  return (
    <div style={{ minHeight: "100vh", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: "bold" }}>Hand Teleop + Manual Control</h1>
      <p style={{ opacity: 0.8 }}>{status}</p>

      {/* Controls row */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Mode</div>
          <label style={{ marginRight: 12 }}>
            <input type="radio" name="mode" value="teleop" checked={mode === "teleop"} onChange={() => setMode("teleop")} style={{ marginRight: 6 }}/>
            Teleop (camera)
          </label>
          <label>
            <input type="radio" name="mode" value="manual" checked={mode === "manual"} onChange={() => setMode("manual")} style={{ marginRight: 6 }}/>
            Manual (sliders)
          </label>
        </div>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Connection</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {hudDot(wsOpen)} <code>{WS_URL}</code>
            <span style={{ marginLeft: 12, fontSize: 12, opacity: 0.8 }}>telemetry: {telemetryHz} Hz</span>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button onClick={() => sendWS({ cmd: "open" })} style={btnStyle}>Open</button>
            <button onClick={() => sendWS({ cmd: "close" })} style={btnStyle}>Close</button>
            <button onClick={() => sendWS({ cmd: "estop" })} style={{ ...btnStyle, borderColor: "#e74c3c", color: "#e74c3c" }}>E-Stop</button>
          </div>
        </div>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Motion Speed</div>
          <Range value={speed} min={0} max={1000} onChange={setSpeed}/>
        </div>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Send Rate (Hz)</div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <Range value={clientHz} min={1} max={50} onChange={setClientHz}/>
            <code>{clientHz} Hz</code>
          </div>
          <div style={{ fontSize:12, opacity:0.7, marginTop:4 }}>
            Caps outgoing WS messages in both modes (coalesced).
          </div>
        </div>


        {mode === "teleop" && (
          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Teleop Smoothing</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Range value={Math.round(teleopSmooth*100)} min={0} max={100} onChange={(v)=>setTeleopSmooth(v/100)} />
              <code>{teleopSmooth.toFixed(2)}</code>
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Manual Stream Rate (Hz)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Range value={manualHz} min={1} max={50} onChange={setManualHz}/>
              <code>{manualHz} Hz</code>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Video + canvas */}
        <div style={{ position: "relative" }}>
          <video ref={videoRef} playsInline muted width={640} height={480} style={{ background: "black", borderRadius: 12 }}/>
          <canvas ref={canvasRef} width={640} height={480} style={{ position: "absolute", left: 0, top: 0, borderRadius: 12, pointerEvents: "none", opacity: 0.9 }}/>
        </div>

        {/* Right panel */}
        <div style={{ minWidth: 320, display: "grid", gap: 12 }}>
          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Live Angles</div>
            <ul style={{ lineHeight: 1.7, margin: 0 }}>
              {angles.map((a, i) => (<li key={i}>{names[i]}: {a}</li>))}
            </ul>
          </div>

          {/* Manual sliders */}
          {mode === "manual" && (
            <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Manual Joint Control</div>
              {angles.map((v,i)=>(
                <LabeledRange key={i} label={names[i]} value={v} onChange={(val)=>setAngleIdx(i,val)} />
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={()=>{const a=[1000,1000,1000,1000,1000,500]; setAngles(a); sendWS({ angles:a });}} style={btnStyle}>Open Hand</button>
                <button onClick={()=>{const a=[0,0,0,0,0,500]; setAngles(a); sendWS({ angles:a });}} style={btnStyle}>Close Hand</button>
              </div>
            </div>
          )}

          {/* Force/Temp visualizer */}
          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Forces & Temps</div>
            <BarChart labels={names} values={forces} max={1000} unit="force"/>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
              Temps: {temps.map((t,i)=>(<span key={i} style={{ marginRight: 8 }}>{names[i].split(" ")[0]}: {t}°C</span>))}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
              Status: {statuses.map((s,i)=>(
                <span key={i} style={{
                  display:"inline-block", padding:"2px 6px", border:"1px solid #ccc",
                  borderRadius: 8, marginRight: 6, background: s===0? "#eefbf2" : "#fff4e6"
                }}>
                  {names[i].split(" ")[0]}:{s}
                </span>
              ))}
            </div>
          </div>

          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, fontSize: 12, opacity: 0.85 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Notes</div>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              <li>Manual mode streams angles continuously at the selected rate.</li>
              <li>Speed slider sets actuator speed (0–1000) on the robot.</li>
              <li>Force bars update from the robot via telemetry.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- UI bits ----------
const btnStyle = { padding: "6px 10px", borderRadius: 8, border: "1px solid #ccc", cursor: "pointer", background:"#fff" };

function Range({ value, min, max, onChange }) {
  return (
    <input type="range" min={min} max={max} step={1} value={value} onChange={(e)=>onChange(Number(e.target.value))}/>
  );
}
function LabeledRange({ label, value, onChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span>{label}</span><code>{value}</code>
      </div>
      <input type="range" min={0} max={1000} step={1} value={value} onChange={(e)=>onChange(Number(e.target.value))} style={{ width:"100%" }}/>
    </div>
  );
}
function BarChart({ labels, values, max=1000 }) {
  return (
    <div>
      {labels.map((label, i)=>(
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>
            <span>{label}</span><span>{values[i] ?? 0}</span>
          </div>
          <div style={{ height:10, background:"#f2f2f2", borderRadius: 6, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${Math.max(0, Math.min(100, (values[i]||0)/max*100))}%`, background:"#4a90e2", transition:"width 120ms linear" }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

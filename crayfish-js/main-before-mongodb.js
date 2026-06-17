require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT;
const signalFile = process.env.SHARED_FILE;
const imageFile    = '/dev/shm/crayfish_frame.jpg';
const statusFile   = '/dev/shm/crayfish_status.json';
const snapshotFile = '/dev/shm/crayfish_snapshot.jpg';
const configFile   = '/dev/shm/crayfish_config.json';
const waterHtmlFile = path.join(__dirname, 'water.html');
const waterStatusFile = '/dev/shm/crayfish_water_status.json';
const waterConfigFile = '/dev/shm/crayfish_water_config.json';
const waterCommandFile = '/dev/shm/crayfish_water_cmd.json';

// ── In-memory detection toggle (resets on server restart) ──────────
//    ──────────
let detectionPaused = false;

function initConfig() {
    if (!fs.existsSync(configFile)) {
        const defaultConfig = {
            activation_start: '08:00',
            activation_end: '20:00',
            motor_zone_left_steps: 200,
            motor_zone_left_dir: 'CW',
            motor_zone_right_steps: 200,
            motor_zone_right_dir: 'CCW',
            motor_zone_boundary: 320
        };
        try { fs.writeFileSync(configFile, JSON.stringify(defaultConfig)); } catch (_) {}
    }
}
initConfig();

function readJsonFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {}
  return fallback;
}

function writeJsonFile(filePath, payload) {
  try {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    console.error(`JSON write error for ${filePath}:`, e);
    return false;
  }
}

function initWaterConfig() {
  if (!fs.existsSync(waterConfigFile)) {
    const defaultWaterConfig = {
      sample_interval_sec: 5,
      alert_interval_sec: 15,
      max_turbidity_ntu: 10,
      max_ammonia_raw: 2000,
      max_temp_c: 28,
      min_flow_lpm: 0.2,
      pump_auto_enabled: true,
      pump_target_level_pct: 55,
      pump_max_runtime_sec: 180,
      pump_cooldown_sec: 60,
      alarm_hold_sec: 30,
      alarm_enabled: true
    };
    writeJsonFile(waterConfigFile, defaultWaterConfig);
  }
}
initWaterConfig();

function readConfig() {
    try {
        if (fs.existsSync(configFile)) return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (_) {}
    return {
        activation_start: '08:00',
        activation_end: '20:00',
        motor_zone_left_steps: 200,
        motor_zone_left_dir: 'CW',
        motor_zone_right_steps: 200,
        motor_zone_right_dir: 'CCW',
        motor_zone_boundary: 320
    };
}

function writeConfig(cfg) {
    try {
        const tmp = configFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
        fs.renameSync(tmp, configFile);
    } catch (e) { console.error('Config write error:', e); }
}

app.use(express.json());

// ── Water dashboard ──────────────────────────────────────────────────────────
app.get('/water', (req, res) => {
  res.sendFile(waterHtmlFile);
});

app.get('/api/water/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const fallback = {
    connected: false,
    note: 'Waiting for water monitor',
    serial_port: process.env.ESP32_SERIAL_PORT || '/dev/ttyUSB0',
    temperature_c: null,
    turbidity_ntu: null,
    ammonia_raw: null,
    flow_lpm: null,
    total_liters: null,
    pump_state: 'idle',
    uv_state: 'off',
    peltier_state: 'off',
    valve_state: 'unknown',
    last_command: null,
    last_reply: null,
    last_update: null,
    ts: Date.now() / 1000
  };
  res.json(readJsonFile(waterStatusFile, fallback));
});

app.get('/api/water/config', (req, res) => {
  const fallback = {
    sample_interval_sec: 5,
    alert_interval_sec: 15,
    max_turbidity_ntu: 10,
    max_ammonia_raw: 2000,
    max_temp_c: 28,
    min_flow_lpm: 0.2,
    pump_auto_enabled: true,
    pump_target_level_pct: 55,
    pump_max_runtime_sec: 180,
    pump_cooldown_sec: 60,
    alarm_hold_sec: 30,
    alarm_enabled: true
  };
  res.json(readJsonFile(waterConfigFile, fallback));
});

app.post('/api/water/config', (req, res) => {
  const existing = readJsonFile(waterConfigFile, {});
  const merged = Object.assign({}, existing, req.body || {});
  writeJsonFile(waterConfigFile, merged);
  res.json({ ok: true, config: merged });
});

app.post('/api/water/control', (req, res) => {
  const action = (req.body && req.body.action ? String(req.body.action) : 'refresh').trim().toLowerCase();
  const value = req.body && req.body.value !== undefined ? req.body.value : null;
  const command = {
    action,
    value,
    source: 'dashboard',
    ts: Date.now()
  };

  if (!writeJsonFile(waterCommandFile, command)) {
    return res.status(500).json({ ok: false, error: 'Failed to queue water command' });
  }

  res.json({ ok: true, queued: command });
});

// ── MJPEG broadcast ───────────────────────────────────────────────────────────
const streamClients = new Set();
function broadcastFrame() {
    if (streamClients.size === 0) return;
    if (!fs.existsSync(imageFile)) return;
    let frame;
    try { frame = fs.readFileSync(imageFile); } catch (_) { return; }
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    for (const client of streamClients) {
        try { client.write(header); client.write(frame); client.write('\r\n'); }
        catch (_) { streamClients.delete(client); }
    }
}
setInterval(broadcastFrame, 100);

// ── Main dashboard ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const config      = readConfig();
    const startTimeVal = config.activation_start || '08:00';
    const endTimeVal   = config.activation_end   || '20:00';
    const zoneLeftSteps   = config.motor_zone_left_steps  || 200;
    const zoneLeftDir     = config.motor_zone_left_dir    || 'CW';
    const zoneRightSteps  = config.motor_zone_right_steps || 200;
    const zoneRightDir    = config.motor_zone_right_dir   || 'CCW';
    const zoneBoundary    = config.motor_zone_boundary    || 320;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crayfish Monitor</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070d12; --surface: #0d1821; --border: #1a3a52;
      --accent: #00c8ff; --accent2: #00ff9d; --danger: #ff4d6d;
      --text: #cde8f5; --muted: #4a7a99;
      --mono: 'Share Tech Mono', monospace; --sans: 'Barlow', sans-serif;
      --zone-left: rgba(0,200,255,0.18); --zone-right: rgba(0,255,157,0.12);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: var(--sans); min-height: 100vh; overflow-x: hidden; }
    body::before {
      content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background-image: linear-gradient(rgba(0,200,255,0.03) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(0,200,255,0.03) 1px, transparent 1px);
      background-size: 40px 40px;
    }
    .scanlines::after {
      content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 4px;
      background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px);
    }
    .layout { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 24px 20px; display: grid; grid-template-rows: auto 1fr auto; gap: 20px; min-height: 100vh; }
    header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-icon { width: 40px; height: 40px; background: linear-gradient(135deg, var(--accent), var(--accent2)); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 20px; }
    .brand-text h1 { font-size: 18px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: white; }
    .brand-text p  { font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: 0.1em; }
    .header-status { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; color: var(--muted); }
    .header-links { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .nav-link {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 12px; border: 1px solid var(--border); border-radius: 999px;
      color: var(--text); text-decoration: none; font-family: var(--mono); font-size: 11px;
      letter-spacing: 0.08em; text-transform: uppercase; background: rgba(255,255,255,0.03);
      transition: all 0.2s ease;
    }
    .nav-link:hover { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 14px rgba(0,200,255,0.15); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); box-shadow: 0 0 8px var(--accent2); animation: pulse 2s ease-in-out infinite; }
    .dot.offline { background: var(--danger); box-shadow: 0 0 8px var(--danger); animation: none; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .main-grid { display: grid; grid-template-columns: 1fr 300px; gap: 16px; align-items: start; }
    @media (max-width: 800px) { .main-grid { grid-template-columns: 1fr; } }
    .camera-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .panel-header-left { display: flex; align-items: center; gap: 8px; }
    .rec-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 6px var(--danger); animation: pulse 1.2s ease-in-out infinite; }
    .camera-wrap { position: relative; background: #000; aspect-ratio: 4/3; }
    canvas#feed { width: 100%; height: 100%; display: block; }
    .corner { position: absolute; width: 18px; height: 18px; border-color: var(--accent); border-style: solid; opacity: 0.7; }
    .corner.tl { top: 10px; left: 10px; border-width: 2px 0 0 2px; }
    .corner.tr { top: 10px; right: 10px; border-width: 2px 2px 0 0; }
    .corner.bl { bottom: 10px; left: 10px; border-width: 0 0 2px 2px; }
    .corner.br { bottom: 10px; right: 10px; border-width: 0 2px 2px 0; }
    .camera-overlay       { position: absolute; bottom: 10px; left: 14px; font-family: var(--mono); font-size: 11px; color: rgba(0,200,255,0.8); text-shadow: 0 0 8px rgba(0,200,255,0.5); pointer-events: none; }
    .camera-overlay-right { position: absolute; bottom: 10px; right: 14px; font-family: var(--mono); font-size: 11px; color: rgba(0,200,255,0.8); pointer-events: none; }
    .side-panel { display: flex; flex-direction: column; gap: 12px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .card-title { font-family: var(--mono); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--muted); margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
    .card-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(26,58,82,0.5); font-size: 13px; }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: var(--muted); font-size: 12px; }
    .stat-value { font-family: var(--mono); font-size: 13px; color: var(--text); }
    .feed-btn { width: 100%; padding: 14px; background: linear-gradient(135deg, rgba(0,200,255,0.15), rgba(0,255,157,0.1)); border: 1px solid var(--accent); border-radius: 6px; color: var(--accent); font-family: var(--mono); font-size: 14px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; transition: all 0.2s ease; }
    .feed-btn:hover  { box-shadow: 0 0 20px rgba(0,200,255,0.25); }
    .feed-btn:active { transform: scale(0.98); }
    .feed-btn-icon { font-size: 18px; display: block; margin-bottom: 4px; }
    .motion-bar-wrap  { margin-top: 6px; }
    .motion-bar-label { display: flex; justify-content: space-between; font-size: 11px; font-family: var(--mono); color: var(--muted); margin-bottom: 6px; }
    .motion-bar-bg    { height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
    .motion-bar-fill  { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--accent2)); width: 0%; transition: width 0.3s ease; }
    .motion-bar-fill.high { background: linear-gradient(90deg, #ff9d00, var(--danger)); }
    .log-area { font-family: var(--mono); font-size: 11px; color: var(--muted); height: 90px; overflow-y: auto; line-height: 1.7; }
    .log-area::-webkit-scrollbar { width: 3px; }
    .log-area::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .log-entry { display: flex; gap: 8px; }
    .log-time { color: var(--accent); opacity: 0.6; flex-shrink: 0; }
    .log-msg.warn { color: #ff9d00; }
    .log-msg.ok   { color: var(--accent2); }
    footer { border-top: 1px solid var(--border); padding-top: 12px; display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--muted); }
    .status-badge { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; padding: 6px 10px; border-radius: 5px; margin-bottom: 10px; }
    .status-badge.connected { background: rgba(0,255,157,0.08); border: 1px solid rgba(0,255,157,0.2); color: var(--accent2); }
    .status-badge.scanning  { background: rgba(0,200,255,0.08); border: 1px solid rgba(0,200,255,0.3); color: var(--accent); }
    .status-badge.idle      { background: rgba(0,200,255,0.05); border: 1px solid rgba(0,200,255,0.15); color: var(--muted); }
    .status-badge.error     { background: rgba(255,77,109,0.08); border: 1px solid rgba(255,77,109,0.2); color: var(--danger); }
    .status-badge.egg       { background: rgba(255,157,0,0.08); border: 1px solid rgba(255,157,0,0.3); color: #ff9d00; }
    .status-badge.zone-left  { background: rgba(0,200,255,0.1); border: 1px solid rgba(0,200,255,0.4); color: var(--accent); }
    .status-badge.zone-right { background: rgba(0,255,157,0.1); border: 1px solid rgba(0,255,157,0.4); color: var(--accent2); }
    .status-badge.paused { background: rgba(255,77,109,0.08); border: 1px solid rgba(255,77,109,0.3); color: var(--danger); }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { display: inline-block; animation: spin 1s linear infinite; }
    input[type="time"], input[type="number"] {
      width: 100%; padding: 6px; border: 1px solid var(--border); border-radius: 4px;
      background: rgba(13,24,33,0.8); color: var(--text); font-family: var(--mono); font-size: 12px;
    }
    select {
      width: 100%; padding: 6px; border: 1px solid var(--border); border-radius: 4px;
      background: rgba(13,24,33,0.8); color: var(--text); font-family: var(--mono); font-size: 12px; cursor: pointer;
    }
    .zone-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .zone-block { border: 1px solid var(--border); border-radius: 5px; padding: 8px; }
    .zone-block.left-zone  { border-color: rgba(0,200,255,0.4); background: rgba(0,200,255,0.04); }
    .zone-block.right-zone { border-color: rgba(0,255,157,0.4); background: rgba(0,255,157,0.04); }
    .zone-label { font-family: var(--mono); font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 6px; }
    .zone-label.left  { color: var(--accent); }
    .zone-label.right { color: var(--accent2); }
    .form-row { margin-bottom: 8px; }
    .form-row label { display: block; font-size: 10px; color: var(--muted); margin-bottom: 3px; font-family: var(--mono); text-transform: uppercase; }
    .save-btn { width: 100%; padding: 8px; background: linear-gradient(135deg,rgba(0,200,255,0.15),rgba(0,255,157,0.1)); border: 1px solid var(--accent); border-radius: 4px; color: var(--accent); font-family: var(--mono); font-size: 12px; font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 8px; }
    .save-btn:hover { box-shadow: 0 0 16px rgba(0,200,255,0.2); }

    /* ── Toggle button ─────────────────────────────────────────────────────── */
    .toggle-btn {
      width: 100%; padding: 10px 14px;
      border-radius: 6px; border: 1px solid var(--accent2);
      background: linear-gradient(135deg, rgba(0,255,157,0.12), rgba(0,200,255,0.08));
      color: var(--accent2); font-family: var(--mono); font-size: 13px;
      font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
      cursor: pointer; transition: all 0.2s ease;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .toggle-btn:hover { box-shadow: 0 0 18px rgba(0,255,157,0.2); }
    .toggle-btn.paused {
      border-color: var(--danger);
      background: linear-gradient(135deg, rgba(255,77,109,0.12), rgba(255,77,109,0.06));
      color: var(--danger);
    }
    .toggle-btn.paused:hover { box-shadow: 0 0 18px rgba(255,77,109,0.2); }

    /* ── Motor manual run ──────────────────────────────────────────────────── */
    .motor-manual-section {
      margin-top: 12px; padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .motor-manual-label {
      font-family: var(--mono); font-size: 9px; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 8px;
    }
    .motor-run-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .run-btn {
      width: 100%; padding: 9px; border-radius: 4px;
      border: 1px solid rgba(255,157,0,0.5);
      background: rgba(255,157,0,0.08);
      color: #ff9d00; font-family: var(--mono); font-size: 12px;
      font-weight: 600; cursor: pointer; text-transform: uppercase;
      letter-spacing: 0.08em; transition: all 0.2s ease;
    }
    .run-btn:hover { box-shadow: 0 0 14px rgba(255,157,0,0.2); border-color: #ff9d00; }
    .run-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* ── Snapshot canvas wrapper ───────────────────────────────────────────── */
    .snapshot-canvas-wrap {
      position: relative; width: 100%; cursor: pointer;
      border: 1px solid var(--border); border-radius: 4px; overflow: hidden; background: #000;
      display: none;
    }
    .snapshot-canvas-wrap:hover::after {
      content: '🔍 Click to enlarge';
      position: absolute; inset: 0; background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
      font-family: var(--mono); font-size: 11px; color: var(--accent);
    }
    canvas#snapshotCanvas { width: 100%; height: auto; display: block; }

    /* ── Modal viewer ──────────────────────────────────────────────────────── */
    #snapshotModal {
      display: none; position: fixed; inset: 0; z-index: 10000;
      background: rgba(0,0,0,0.88); align-items: center; justify-content: center;
    }
    #snapshotModal.open { display: flex; }
    .modal-inner {
      position: relative; max-width: 90vw; max-height: 90vh;
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
    }
    canvas#snapshotModalCanvas { display: block; max-width: 90vw; max-height: 80vh; }
    .modal-close {
      position: absolute; top: 10px; right: 10px;
      background: rgba(0,0,0,0.7); border: 1px solid var(--border);
      color: var(--text); font-size: 18px; width: 30px; height: 30px;
      border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
      font-family: var(--mono);
    }
    .modal-close:hover { background: rgba(255,77,109,0.3); border-color: var(--danger); }
    .modal-meta {
      background: var(--surface); padding: 8px 14px;
      font-family: var(--mono); font-size: 11px; color: var(--muted);
      display: flex; justify-content: space-between; align-items: center;
    }

    /* ── Toast notifications ───────────────────────────────────────────────── */
    #toastContainer {
      position: fixed; top: 24px; right: 24px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    }
    .toast {
      background: var(--surface); border: 1px solid var(--border); border-left-width: 3px;
      border-left-color: var(--accent); border-radius: 6px; padding: 11px 16px;
      font-family: var(--mono); font-size: 12px; color: var(--text);
      box-shadow: 0 6px 28px rgba(0,0,0,0.55); display: flex; align-items: center; gap: 10px;
      max-width: 300px; pointer-events: all;
      animation: toastIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;
    }
    .toast.success { border-left-color: var(--accent2); }
    .toast.warning { border-left-color: #ff9d00; }
    .toast.error   { border-left-color: var(--danger); }
    .toast.info    { border-left-color: var(--accent); }
    .toast-close { margin-left: auto; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; padding: 0 2px; }
    .toast-close:hover { color: var(--text); }
    @keyframes toastIn  { from { opacity:0; transform:translateX(50px) scale(0.95); } to { opacity:1; transform:translateX(0) scale(1); } }
    @keyframes toastOut { to   { opacity:0; transform:translateX(50px); } }
  </style>
</head>
<body>

<div id="toastContainer"></div>

<!-- Snapshot modal -->
<div id="snapshotModal">
  <div class="modal-inner">
    <button class="modal-close" onclick="closeModal()">✕</button>
    <canvas id="snapshotModalCanvas"></canvas>
    <div class="modal-meta">
      <span id="modalMeta">Snapshot</span>
      <span id="modalZone" style="color:var(--accent);">—</span>
    </div>
  </div>
</div>

<div class="layout">
  <header>
    <div class="brand">
      <div class="brand-icon">🦞</div>
      <div class="brand-text">
        <h1>Crayfish Monitor</h1>
        <p>AQUATIC SURVEILLANCE SYSTEM · v2.3</p>
      </div>
    </div>
    <div class="header-links">
      <a class="nav-link" href="/water">Water Dashboard</a>
      <div class="header-status">
        <div class="dot" id="statusDot"></div>
        <span id="statusText">CONNECTING</span>
      </div>
    </div>
  </header>

  <div class="main-grid">
    <!-- Live camera feed -->
    <div class="camera-panel">
      <div class="panel-header">
        <div class="panel-header-left">
          <div class="rec-dot"></div>
          LIVE FEED · CAM-01
        </div>
        <span id="fpsBadge">-- FPS</span>
      </div>
      <div class="camera-wrap scanlines">
        <canvas id="feed" width="640" height="480"></canvas>
        <div class="corner tl"></div><div class="corner tr"></div>
        <div class="corner bl"></div><div class="corner br"></div>
        <div class="camera-overlay" id="camTime">--:--:--</div>
        <div class="camera-overlay-right">640×480</div>
      </div>
    </div>

    <!-- Side panel -->
    <div class="side-panel">

      <!-- ── System Controls (new) ───────────────────────────────────────── -->
      <div class="card">
        <div class="card-title">System Controls</div>

        <!-- Detection toggle -->
        <div style="margin-bottom:12px;">
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.12em;margin-bottom:6px;">
            Auto-Detection
          </div>
          <button class="toggle-btn" id="detectionToggleBtn" onclick="toggleDetection()">
            <span id="detectionToggleIcon">⬤</span>
            <span id="detectionToggleLabel">ACTIVE</span>
          </button>
          <div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:5px;text-align:center;" id="detectionToggleHint">
            Detection running — click to pause
          </div>
        </div>

        <!-- Detection status row -->
        <div class="stat-row">
          <span class="stat-label">State</span>
          <span class="stat-value" id="detectionStateValue" style="color:var(--accent2);">Active</span>
        </div>
        <div class="stat-row" style="border-bottom:none;">
          <span class="stat-label">Note</span>
          <span class="stat-value" id="detectionStateNote" style="color:var(--muted);font-size:11px;">—</span>
        </div>
      </div>

      <!-- Manual control -->
      <div class="card">
        <div class="card-title">Manual Control</div>
        <button class="feed-btn" id="feedBtn">
          <span class="feed-btn-icon">🍤</span>FEED NOW
        </button>
      </div>

      <!-- Detection Pipeline Status -->
      <div class="card">
        <div class="card-title">Detection Pipeline</div>
        <div class="status-badge idle" id="roboflowBadge">
          <span id="roboflowDot">◌</span>
          <span id="roboflowLabel">IDLE</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Last scan</span>
          <span class="stat-value" id="roboflowLastScan" style="color:var(--muted)">—</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Result</span>
          <span class="stat-value" id="roboflowResult" style="color:var(--muted)">—</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Confidence</span>
          <span class="stat-value" id="roboflowConfidence" style="color:var(--muted)">—</span>
        </div>

        <!-- Zone indicator -->
        <div id="zoneIndicatorRow" style="display:none; margin-top:8px;">
          <div class="status-badge zone-left" id="zoneBadge">
            <span>📍</span>
            <span id="zoneLabel">ZONE: —</span>
          </div>
        </div>

        <!-- Egg color indicator -->
        <div id="eggColorRow" style="display:none;margin-top:8px;">
          <div class="status-badge egg"><span>🥚</span><span>EGG COLORS DETECTED</span></div>
        </div>

        <!-- Snapshot section -->
        <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-family:var(--mono);font-size:10px;color:var(--muted);">SNAPSHOT</span>
            <span id="snapshotScanBadge" style="font-family:var(--mono);font-size:10px;color:var(--accent);display:none;">
              <span class="spin">⟳</span> SCANNING
            </span>
          </div>
          <div class="snapshot-canvas-wrap" id="snapshotCanvasWrap" onclick="openModal()">
            <canvas id="snapshotCanvas"></canvas>
            <div id="snapshotEggBadge"
                 style="display:none;position:absolute;bottom:6px;left:6px;background:rgba(255,157,0,0.88);border-radius:4px;padding:3px 8px;font-family:var(--mono);font-size:10px;color:#000;font-weight:bold;">
              🥚 EGGS
            </div>
          </div>
          <div id="snapshotPlaceholder"
               style="width:100%;height:110px;background:rgba(0,0,0,0.3);border:1px dashed var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-family:var(--mono);font-size:11px;">
            Waiting for motion…
          </div>
        </div>
      </div>

      <!-- AI Status -->
      <div class="card">
        <div class="card-title">AI Status</div>
        <div class="status-badge idle" id="geminiBadge">
          <span id="geminiDot">◌</span>
          <span id="geminiLabel">CHECKING…</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Last detection</span>
          <span class="stat-value" id="geminiLastDetect" style="color:var(--muted)">—</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Note</span>
          <span class="stat-value" id="geminiNote"
                style="color:var(--muted);font-size:11px;font-style:italic;text-align:right;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            Watching…
          </span>
        </div>
      </div>

      <!-- Motor Zone Settings -->
      <div class="card">
        <div class="card-title">Motor Zone Settings</div>
        <div class="form-row">
          <label>Zone Boundary (px, 0–640)</label>
          <input type="number" id="zoneBoundaryInput" min="0" max="640" value="${zoneBoundary}" placeholder="320">
        </div>
        <div class="zone-grid">
          <div class="zone-block left-zone">
            <div class="zone-label left">◀ LEFT ZONE</div>
            <div class="form-row">
              <label>Steps</label>
              <input type="number" id="zoneLeftSteps" min="1" max="9999" value="${zoneLeftSteps}">
            </div>
            <div class="form-row">
              <label>Direction</label>
              <select id="zoneLeftDir">
                <option value="CW"  ${zoneLeftDir === 'CW'  ? 'selected' : ''}>CW  (Clockwise)</option>
                <option value="CCW" ${zoneLeftDir === 'CCW' ? 'selected' : ''}>CCW (Counter-CW)</option>
              </select>
            </div>
          </div>
          <div class="zone-block right-zone">
            <div class="zone-label right">RIGHT ZONE ▶</div>
            <div class="form-row">
              <label>Steps</label>
              <input type="number" id="zoneRightSteps" min="1" max="9999" value="${zoneRightSteps}">
            </div>
            <div class="form-row">
              <label>Direction</label>
              <select id="zoneRightDir">
                <option value="CW"  ${zoneRightDir === 'CW'  ? 'selected' : ''}>CW  (Clockwise)</option>
                <option value="CCW" ${zoneRightDir === 'CCW' ? 'selected' : ''}>CCW (Counter-CW)</option>
              </select>
            </div>
          </div>
        </div>
        <button class="save-btn" onclick="saveMotorSettings()">⚙ Save Motor Settings</button>

        <!-- ── Manual Motor Run (inline, new) ──────────────────────────────── -->
        <div class="motor-manual-section">
          <div class="motor-manual-label">⚡ Manual Motor Run</div>
          <div class="motor-run-grid">
            <div class="form-row" style="margin-bottom:0;">
              <label>Steps</label>
              <input type="number" id="manualSteps" min="1" max="9999" value="200" placeholder="200">
            </div>
            <div class="form-row" style="margin-bottom:0;">
              <label>Direction</label>
              <select id="manualDir">
                <option value="CW">CW  (Clockwise)</option>
                <option value="CCW">CCW (Counter-CW)</option>
              </select>
            </div>
          </div>
          <button class="run-btn" id="motorRunBtn" onclick="runMotorManual()">▶ Run Motor</button>
          <div class="stat-row" style="margin-top:6px;border-bottom:none;padding-bottom:0;">
            <span class="stat-label">Status</span>
            <span class="stat-value" id="motorRunStatus" style="color:var(--muted);font-size:11px;">Idle</span>
          </div>
        </div>

        <div class="stat-row" style="margin-top:8px;">
          <span class="stat-label">Zone save status</span>
          <span class="stat-value" id="motorStatus" style="color:var(--accent2);">Ready</span>
        </div>
      </div>

      <!-- Feeding Schedule -->
      <div class="card">
        <div class="card-title">Feeding Schedule</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
          <div>
            <label style="display:block;font-size:11px;color:var(--muted);margin-bottom:5px;font-family:var(--mono);text-transform:uppercase;">START</label>
            <input type="time" id="startTime" value="${startTimeVal}">
          </div>
          <div>
            <label style="display:block;font-size:11px;color:var(--muted);margin-bottom:5px;font-family:var(--mono);text-transform:uppercase;">END</label>
            <input type="time" id="endTime" value="${endTimeVal}">
          </div>
        </div>
        <button onclick="saveSchedule()" class="save-btn">✓ Save Schedule</button>
        <div class="stat-row" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          <span class="stat-label">Status</span>
          <span class="stat-value" style="color:var(--accent2);" id="scheduleStatus">Ready</span>
        </div>
      </div>

      <!-- Motion bar -->
      <div class="card">
        <div class="card-title">Motion Level</div>
        <div class="motion-bar-wrap">
          <div class="motion-bar-label">
            <span>MOTION</span>
            <span id="motionPct">0%</span>
          </div>
          <div class="motion-bar-bg">
            <div class="motion-bar-fill" id="motionBar"></div>
          </div>
        </div>
      </div>

      <!-- Event log -->
      <div class="card">
        <div class="card-title">Event Log</div>
        <div class="log-area" id="logArea"></div>
      </div>

    </div><!-- /side-panel -->
  </div><!-- /main-grid -->

  <footer>
    <span>CRAYFISH MONITOR SYSTEM</span>
    <span id="footerTime"></span>
  </footer>
</div>

<script>
  // ── Element refs ─────────────────────────────────────────────────────────────
  const canvas             = document.getElementById('feed');
  const ctx                = canvas.getContext('2d');
  const statusDot          = document.getElementById('statusDot');
  const statusText         = document.getElementById('statusText');
  const fpsBadge           = document.getElementById('fpsBadge');
  const motionBar          = document.getElementById('motionBar');
  const motionPct          = document.getElementById('motionPct');
  const logArea            = document.getElementById('logArea');
  const camTime            = document.getElementById('camTime');
  const footerTime         = document.getElementById('footerTime');
  const geminiBadge        = document.getElementById('geminiBadge');
  const geminiLabel        = document.getElementById('geminiLabel');
  const geminiLastDetect   = document.getElementById('geminiLastDetect');
  const geminiNote         = document.getElementById('geminiNote');
  const roboflowBadge      = document.getElementById('roboflowBadge');
  const roboflowLabel      = document.getElementById('roboflowLabel');
  const roboflowLastScan   = document.getElementById('roboflowLastScan');
  const roboflowResult     = document.getElementById('roboflowResult');
  const roboflowConfidence = document.getElementById('roboflowConfidence');
  const eggColorRow        = document.getElementById('eggColorRow');
  const snapshotCanvasWrap = document.getElementById('snapshotCanvasWrap');
  const snapshotCanvas     = document.getElementById('snapshotCanvas');
  const snapshotCtx        = snapshotCanvas.getContext('2d');
  const snapshotPlaceholder= document.getElementById('snapshotPlaceholder');
  const snapshotScanBadge  = document.getElementById('snapshotScanBadge');
  const snapshotEggBadge   = document.getElementById('snapshotEggBadge');
  const zoneIndicatorRow   = document.getElementById('zoneIndicatorRow');
  const zoneBadge          = document.getElementById('zoneBadge');
  const zoneLabel          = document.getElementById('zoneLabel');

  // ── Runtime state ─────────────────────────────────────────────────────────
  let fpsCounter      = 0;
  let prevFrame       = null;
  let online          = false;
  let boxOpacity      = 0, boxTarget = 0;
  let detectionNote   = '';
  let isScanningState = false;
  let isDetected      = false;
  let isEggColor      = false;
  let lastSnapshotTs  = 0;
  let currentBbox     = null;
  let currentZone     = '';
  let snapshotBbox    = null;
  let snapshotZone    = '';
  let snapshotDataUrl = null;
  let zoneBoundaryPx  = ${zoneBoundary};

  let prevScanning    = false;
  let prevDetected    = false;
  let prevEggColor    = false;
  let geminiConnected = null;

  // Detection toggle state (mirrors server)
  let detectionIsPaused = false;

  // ── Toast system ──────────────────────────────────────────────────────────
  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = \`toast \${type}\`;
    const msg = document.createElement('span');
    msg.textContent = message;
    const btn = document.createElement('button');
    btn.className = 'toast-close'; btn.textContent = '✕';
    btn.onclick = () => dismissToast(toast);
    toast.appendChild(msg); toast.appendChild(btn);
    container.appendChild(toast);
    if (duration > 0) setTimeout(() => dismissToast(toast), duration);
  }
  function dismissToast(toast) {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  function addLog(msg, type = '') {
    const t = new Date().toTimeString().slice(0, 8);
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = \`<span class="log-time">\${t}</span><span class="log-msg \${type}">\${msg}</span>\`;
    logArea.prepend(entry);
    while (logArea.children.length > 25) logArea.removeChild(logArea.lastChild);
  }

  // ── Online indicator ──────────────────────────────────────────────────────
  function setOnline(state) {
    if (online === state) return;
    online = state;
    statusDot.className = 'dot' + (state ? '' : ' offline');
    statusText.textContent = state ? 'LIVE' : 'OFFLINE';
    addLog(state ? 'Stream connected' : 'Stream lost', state ? 'ok' : 'warn');
  }

  // ── Detection toggle UI sync ──────────────────────────────────────────────
  function syncDetectionToggleUI(paused) {
    detectionIsPaused = paused;
    const btn   = document.getElementById('detectionToggleBtn');
    const icon  = document.getElementById('detectionToggleIcon');
    const label = document.getElementById('detectionToggleLabel');
    const hint  = document.getElementById('detectionToggleHint');
    const stateVal  = document.getElementById('detectionStateValue');
    const stateNote = document.getElementById('detectionStateNote');

    if (paused) {
      btn.className   = 'toggle-btn paused';
      icon.textContent  = '⏸';
      label.textContent = 'PAUSED';
      hint.textContent  = 'Detection paused — click to resume';
      stateVal.textContent  = 'Paused';
      stateVal.style.color  = 'var(--danger)';
      stateNote.textContent = 'Motion ignored until resumed';
    } else {
      btn.className   = 'toggle-btn';
      icon.textContent  = '⬤';
      label.textContent = 'ACTIVE';
      hint.textContent  = 'Detection running — click to pause';
      stateVal.textContent  = 'Active';
      stateVal.style.color  = 'var(--accent2)';
      stateNote.textContent = 'Watching for motion…';
    }
  }

  // ── Toggle detection API call ─────────────────────────────────────────────
  async function toggleDetection() {
    const btn = document.getElementById('detectionToggleBtn');
    btn.disabled = true;
    try {
      const res  = await fetch('/api/detection/toggle', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        syncDetectionToggleUI(data.paused);
        const msg = data.paused ? '⏸ Detection paused' : '▶ Detection resumed';
        addLog(msg, data.paused ? 'warn' : 'ok');
        showToast(msg, data.paused ? 'warning' : 'success', 3500);
      }
    } catch (e) {
      showToast('Toggle failed — check connection', 'error', 3000);
    } finally {
      btn.disabled = false;
    }
  }

  // ── Poll detection state on load ──────────────────────────────────────────
  async function fetchDetectionState() {
    try {
      const res  = await fetch('/api/detection/status');
      const data = await res.json();
      syncDetectionToggleUI(!!data.paused);
    } catch (_) {}
  }

  // ── Manual motor run ──────────────────────────────────────────────────────
  async function runMotorManual() {
    const steps     = parseInt(document.getElementById('manualSteps').value) || 200;
    const direction = document.getElementById('manualDir').value;
    const btn       = document.getElementById('motorRunBtn');
    const statusEl  = document.getElementById('motorRunStatus');

    if (steps < 1 || steps > 9999) {
      showToast('Steps must be between 1 and 9999', 'error', 3000);
      return;
    }

    btn.disabled = true;
    statusEl.textContent  = 'Running…';
    statusEl.style.color  = 'var(--accent)';

    try {
      const res  = await fetch('/api/motor/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps, direction })
      });
      const data = await res.json();
      if (data.ok) {
        statusEl.textContent = \`Done ✓ (\${steps} steps \${direction})\`;
        statusEl.style.color = 'var(--accent2)';
        addLog(\`⚙ Motor: \${steps} steps \${direction}\`, 'ok');
        showToast(\`⚙ Motor ran \${steps} steps \${direction}\`, 'success', 3000);
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (e) {
      statusEl.textContent = 'Error — ' + e.message;
      statusEl.style.color = 'var(--danger)';
      showToast('Motor run failed: ' + e.message, 'error', 4000);
      addLog('Motor run failed: ' + e.message, 'warn');
    } finally {
      btn.disabled = false;
      setTimeout(() => {
        statusEl.textContent = 'Idle';
        statusEl.style.color = 'var(--muted)';
      }, 5000);
    }
  }

  // ── Client-side motion estimate ───────────────────────────────────────────
  function estimateMotion(imageData) {
    if (!prevFrame) { prevFrame = imageData; return 0; }
    let diff = 0, count = 0;
    const d1 = imageData.data, d2 = prevFrame.data;
    for (let i = 0; i < d1.length; i += 40 * 4) {
      if ((Math.abs(d1[i]-d2[i]) + Math.abs(d1[i+1]-d2[i+1]) + Math.abs(d1[i+2]-d2[i+2])) / 3 > 15) diff++;
      count++;
    }
    prevFrame = imageData;
    return Math.min(100, Math.round((diff / count) * 300));
  }

  // ── Zone overlay on live canvas ───────────────────────────────────────────
  function drawZoneOverlay() {
    const w = canvas.width, h = canvas.height;
    const bx = Math.round(zoneBoundaryPx * (w / 640));
    ctx.save();
    ctx.fillStyle = 'rgba(0,200,255,0.06)';
    ctx.fillRect(0, 0, bx, h);
    ctx.fillStyle = 'rgba(0,255,157,0.05)';
    ctx.fillRect(bx, 0, w - bx, h);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '10px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.4)';
    ctx.fillText('◀ LEFT', 6, 16);
    ctx.fillStyle = 'rgba(0,255,157,0.4)';
    ctx.fillText('RIGHT ▶', bx + 6, 16);
    ctx.restore();
  }

  // ── Detection bounding-box overlay on live feed ───────────────────────────
  function drawBoundingBox() {
    if (boxOpacity <= 0) return;
    const w = canvas.width, h = canvas.height;
    let x1, y1, x2, y2;
    if (currentBbox && currentBbox.length === 4) {
      const scaleX = w / 640, scaleY = h / 480;
      x1 = currentBbox[0] * scaleX; y1 = currentBbox[1] * scaleY;
      x2 = currentBbox[2] * scaleX; y2 = currentBbox[3] * scaleY;
    } else {
      const pad = 18;
      x1 = pad; y1 = pad; x2 = w - pad; y2 = h - pad;
    }
    const bw = x2 - x1, bh = y2 - y1;
    const pulse    = 0.75 + 0.25 * Math.sin(Date.now() / 280);
    const boxColor = isEggColor ? '#ff9d00' : (currentZone === 'left' ? '#00c8ff' : '#00ff9d');
    const label    = isEggColor ? '🦞  CRAYFISH + 🥚 EGGS'
                   : (currentZone === 'left'  ? '🦞  LEFT ZONE'
                   :  currentZone === 'right' ? '🦞  RIGHT ZONE'
                   :                           '🦞  CRAYFISH DETECTED');
    ctx.save();
    ctx.globalAlpha = boxOpacity * pulse;
    ctx.shadowColor = boxColor; ctx.shadowBlur = 20;
    ctx.strokeStyle = boxColor; ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, bw, bh);
    const cs = 14;
    ctx.lineWidth = 3;
    [[x1,y1,cs,0,0,cs],[x2,y1,-cs,0,0,cs],[x1,y2,cs,0,0,-cs],[x2,y2,-cs,0,0,-cs]]
      .forEach(([px,py,dx1,dy1,dx2,dy2]) => {
        ctx.beginPath(); ctx.moveTo(px+dx1,py+dy1); ctx.lineTo(px,py); ctx.lineTo(px+dx2,py+dy2); ctx.stroke();
      });
    ctx.globalAlpha = boxOpacity; ctx.shadowBlur = 0;
    const labelW = 220;
    ctx.fillStyle = 'rgba(0,20,10,0.78)';
    ctx.fillRect(x1, y1, labelW, 26);
    ctx.strokeStyle = boxColor; ctx.lineWidth = 1;
    ctx.strokeRect(x1, y1, labelW, 26);
    ctx.fillStyle = boxColor;
    ctx.font = 'bold 11px "Share Tech Mono", monospace';
    ctx.fillText(label, x1 + 8, y1 + 17);
    if (detectionNote) {
      ctx.font = '10px "Share Tech Mono", monospace';
      ctx.fillStyle = 'rgba(0,255,157,0.65)';
      ctx.fillText(detectionNote.slice(0, 68), x1 + 4, y2 + 14);
    }
    ctx.restore();
  }

  // ── Scanning overlay ──────────────────────────────────────────────────────
  function drawScanningOverlay() {
    if (!isScanningState) return;
    const w = canvas.width, h = canvas.height;
    const t = Date.now();
    const alpha = 0.5 + 0.35 * Math.sin(t / 400);
    ctx.save();
    ctx.setLineDash([10, 6]);
    ctx.lineDashOffset = -(t / 40) % 16;
    ctx.strokeStyle = \`rgba(0,200,255,\${alpha})\`;
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(0,20,30,0.8)'; ctx.fillRect(10, 10, 180, 28);
    ctx.strokeStyle = 'rgba(0,200,255,0.6)'; ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, 180, 28);
    ctx.fillStyle = \`rgba(0,200,255,\${0.7 + 0.3 * Math.sin(t / 300)})\`;
    ctx.font = '11px "Share Tech Mono", monospace';
    ctx.fillText('⟳  ANALYZING FRAME…', 20, 28);
    ctx.restore();
  }

  // ── Live camera feed loop ─────────────────────────────────────────────────
  function fetchFrame() {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      drawZoneOverlay();
      if (boxOpacity < boxTarget) boxOpacity = Math.min(boxTarget, boxOpacity + 0.08);
      if (boxOpacity > boxTarget) boxOpacity = Math.max(boxTarget, boxOpacity - 0.05);
      drawBoundingBox();
      drawScanningOverlay();
      const imageData   = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const motionLevel = estimateMotion(imageData);
      motionBar.style.width = motionLevel + '%';
      motionPct.textContent = motionLevel + '%';
      motionBar.className   = 'motion-bar-fill' + (motionLevel > 60 ? ' high' : '');
      fpsCounter++;
      setOnline(true);
      setTimeout(fetchFrame, 33);
    };
    img.onerror = () => { setOnline(false); setTimeout(fetchFrame, 1000); };
    img.src = '/snapshot?t=' + Date.now();
  }

  // ── Draw bbox on snapshot canvas ──────────────────────────────────────────
  function drawSnapshotBbox(imgElement, bbox, zone, eggColor, isModal) {
    const targetCanvas = isModal
      ? document.getElementById('snapshotModalCanvas')
      : snapshotCanvas;
    const tCtx = targetCanvas.getContext('2d');
    const naturalW = imgElement.naturalWidth  || imgElement.width  || 640;
    const naturalH = imgElement.naturalHeight || imgElement.height || 480;
    targetCanvas.width  = naturalW;
    targetCanvas.height = naturalH;
    tCtx.drawImage(imgElement, 0, 0, naturalW, naturalH);
    if (!bbox || bbox.length !== 4) return;
    const [x1, y1, x2, y2] = bbox;
    const bw = x2 - x1, bh = y2 - y1;
    const boxColor = eggColor ? '#ff9d00' : (zone === 'left' ? '#00c8ff' : '#00ff9d');
    const label    = eggColor ? '🦞 + 🥚 EGGS'
                   : (zone === 'left' ? '🦞 LEFT ZONE' : zone === 'right' ? '🦞 RIGHT ZONE' : '🦞 DETECTED');
    tCtx.save();
    tCtx.shadowColor = boxColor; tCtx.shadowBlur = 14;
    tCtx.strokeStyle = boxColor; tCtx.lineWidth = 2;
    tCtx.strokeRect(x1, y1, bw, bh);
    const cs = 12;
    tCtx.lineWidth = 3;
    [[x1,y1,cs,0,0,cs],[x2,y1,-cs,0,0,cs],[x1,y2,cs,0,0,-cs],[x2,y2,-cs,0,0,-cs]]
      .forEach(([px,py,dx1,dy1,dx2,dy2]) => {
        tCtx.beginPath(); tCtx.moveTo(px+dx1,py+dy1); tCtx.lineTo(px,py); tCtx.lineTo(px+dx2,py+dy2); tCtx.stroke();
      });
    tCtx.shadowBlur = 0;
    const labelW = Math.min(bw, 200);
    tCtx.fillStyle = 'rgba(0,0,0,0.72)';
    tCtx.fillRect(x1, y1 - 22, labelW, 22);
    tCtx.fillStyle = boxColor;
    tCtx.font = 'bold 11px "Share Tech Mono", monospace';
    tCtx.fillText(label, x1 + 6, y1 - 7);
    tCtx.restore();
  }

  // ── Fetch & display snapshot ──────────────────────────────────────────────
  function fetchAndDisplaySnapshot(bbox, zone, eggColor) {
    const img = new Image();
    img.onload = () => {
      snapshotCanvas.width  = img.naturalWidth  || 640;
      snapshotCanvas.height = img.naturalHeight || 480;
      drawSnapshotBbox(img, bbox, zone, eggColor, false);
      snapshotCanvasWrap.style.display = 'block';
      snapshotPlaceholder.style.display = 'none';
      snapshotDataUrl = img.src;
      snapshotBbox    = bbox;
      snapshotZone    = zone;
    };
    img.onerror = () => {
      snapshotCanvasWrap.style.display = 'none';
      snapshotPlaceholder.style.display = 'flex';
    };
    img.src = '/snapshot-captured?t=' + Date.now();
  }

  // ── Modal open/close ──────────────────────────────────────────────────────
  function openModal() {
    if (!snapshotDataUrl) return;
    const modal = document.getElementById('snapshotModal');
    const modalCanvas = document.getElementById('snapshotModalCanvas');
    const img = new Image();
    img.onload = () => {
      modalCanvas.width  = img.naturalWidth  || 640;
      modalCanvas.height = img.naturalHeight || 480;
      drawSnapshotBbox(img, snapshotBbox, snapshotZone, isEggColor, true);
      document.getElementById('modalMeta').textContent =
        'Captured · ' + new Date().toLocaleTimeString();
      document.getElementById('modalZone').textContent =
        snapshotZone ? 'Zone: ' + snapshotZone.toUpperCase() : '—';
      modal.classList.add('open');
    };
    img.src = '/snapshot-captured?t=' + Date.now();
  }
  function closeModal() {
    document.getElementById('snapshotModal').classList.remove('open');
  }
  document.getElementById('snapshotModal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });

  // ── Status polling ────────────────────────────────────────────────────────
  async function pollStatus() {
    try {
      const res  = await fetch('/status');
      const data = await res.json();

      if (geminiConnected === null) {
        geminiConnected = true;
        geminiBadge.className = 'status-badge connected';
        geminiLabel.textContent = 'CONNECTED';
        addLog('AI backend connected', 'ok');
      }

      const scanning = !!data.scanning;
      const detected = !!data.crayfish;
      const eggColor = !!data.egg_color;
      const note     = data.note || '';
      const bbox     = Array.isArray(data.bbox) ? data.bbox : null;
      const zone     = data.zone || '';

      isDetected      = detected;
      isEggColor      = eggColor;
      isScanningState = scanning;
      detectionNote   = note;
      currentBbox     = bbox;
      currentZone     = zone;

      if (typeof data.zone_boundary === 'number') {
        zoneBoundaryPx = data.zone_boundary;
      }

      // Sync detection paused state from server if provided
      if (typeof data.detection_paused === 'boolean') {
        syncDetectionToggleUI(data.detection_paused);
      }

      boxTarget = detected ? 1 : 0;

      const nowStr = new Date().toTimeString().slice(0, 8);

      if (data.snapshot_ts && data.snapshot_ts !== lastSnapshotTs) {
        lastSnapshotTs = data.snapshot_ts;
        fetchAndDisplaySnapshot(bbox, zone, eggColor);
        addLog('📸 Motion snapshot captured', 'ok');
        showToast('📸 Snapshot captured', 'info', 2500);
      }

      snapshotEggBadge.style.display = (detected && eggColor) ? 'block' : 'none';
      snapshotScanBadge.style.display = scanning ? 'inline-flex' : 'none';

      if (detected && zone) {
        zoneIndicatorRow.style.display = 'block';
        zoneBadge.className = 'status-badge ' + (zone === 'left' ? 'zone-left' : 'zone-right');
        zoneLabel.textContent = 'ZONE: ' + zone.toUpperCase();
      } else {
        zoneIndicatorRow.style.display = 'none';
      }

      if (scanning) {
        roboflowBadge.className      = 'status-badge scanning';
        roboflowLabel.textContent     = 'SCANNING…';
        roboflowResult.textContent    = 'Analyzing snapshot…';
        roboflowResult.style.color    = 'var(--accent)';
        roboflowConfidence.textContent= '—';
        roboflowLastScan.textContent  = nowStr;
        roboflowLastScan.style.color  = 'var(--accent)';
        eggColorRow.style.display     = 'none';
      } else if (detected) {
        roboflowBadge.className      = 'status-badge connected';
        roboflowLabel.textContent     = 'DETECTED';
        roboflowResult.textContent    = 'CRAYFISH CONFIRMED';
        roboflowResult.style.color    = 'var(--accent2)';
        roboflowLastScan.textContent  = nowStr;
        roboflowLastScan.style.color  = 'var(--accent2)';
        roboflowConfidence.textContent= (data.confidence || '?').toUpperCase();
        roboflowConfidence.style.color= data.confidence === 'high' ? 'var(--accent2)' : '#ff9d00';
        eggColorRow.style.display     = eggColor ? 'block' : 'none';
        geminiLastDetect.textContent  = nowStr;
        geminiLastDetect.style.color  = 'var(--accent2)';
        geminiNote.textContent        = note.slice(0, 50) || '—';
      } else {
        roboflowBadge.className      = 'status-badge idle';
        roboflowLabel.textContent     = 'IDLE';
        roboflowResult.textContent    = '—';
        roboflowResult.style.color    = 'var(--muted)';
        roboflowConfidence.textContent= '—';
        eggColorRow.style.display     = 'none';
        geminiNote.textContent        = note.slice(0, 50) || 'Watching…';
      }

      if (scanning && !prevScanning) {
        addLog('🚨 Motion detected — scanning…', 'warn');
        showToast('🚨 Motion detected — scanning…', 'info', 4000);
      }
      if (!scanning && prevScanning && !detected) {
        addLog('Scan complete — no crayfish found.', '');
        showToast('No crayfish detected', 'info', 3000);
      }
      if (detected && !prevDetected) {
        const zoneMsg = zone ? ' (' + zone.toUpperCase() + ' zone)' : '';
        addLog('🦞 Crayfish confirmed!' + zoneMsg + ' (' + (data.confidence || '?') + ')', 'ok');
        showToast('🦞 Crayfish confirmed!' + zoneMsg, 'success', 6000);
      }
      if (detected && eggColor && !prevEggColor) {
        addLog('🥚 Eggs detected on crayfish!', 'warn');
        showToast('🥚 Eggs detected on crayfish!', 'warning', 6000);
      }

      prevScanning = scanning;
      prevDetected = detected;
      prevEggColor = eggColor;

    } catch (_) {
      if (geminiConnected === null) {
        geminiBadge.className   = 'status-badge error';
        geminiLabel.textContent  = 'UNAVAILABLE';
      }
    }
  }

  // ── Manual feed button ────────────────────────────────────────────────────
  document.getElementById('feedBtn').addEventListener('click', async () => {
    const btn = document.getElementById('feedBtn');
    btn.disabled = true; btn.textContent = 'SENDING…';
    try {
      await fetch('/feed', { method: 'POST' });
      addLog('🍤 Manual feed triggered', 'ok');
      showToast('🍤 Manual feed triggered!', 'success', 3000);
    } catch (_) {
      addLog('Feed command failed', 'warn');
      showToast('Feed command failed', 'error', 3000);
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '<span class="feed-btn-icon">🍤</span>FEED NOW';
      }, 2000);
    }
  });

  // ── Save motor settings ───────────────────────────────────────────────────
  function saveMotorSettings() {
    const boundary   = parseInt(document.getElementById('zoneBoundaryInput').value) || 320;
    const leftSteps  = parseInt(document.getElementById('zoneLeftSteps').value)     || 200;
    const leftDir    = document.getElementById('zoneLeftDir').value;
    const rightSteps = parseInt(document.getElementById('zoneRightSteps').value)    || 200;
    const rightDir   = document.getElementById('zoneRightDir').value;

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        motor_zone_boundary:    boundary,
        motor_zone_left_steps:  leftSteps,
        motor_zone_left_dir:    leftDir,
        motor_zone_right_steps: rightSteps,
        motor_zone_right_dir:   rightDir
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        document.getElementById('motorStatus').textContent = 'Saved ✓';
        document.getElementById('motorStatus').style.color = 'var(--accent2)';
        zoneBoundaryPx = boundary;
        addLog('⚙ Motor settings saved (boundary=' + boundary + 'px)', 'ok');
        showToast('⚙ Motor settings saved', 'success', 3000);
        setTimeout(() => { document.getElementById('motorStatus').textContent = 'Ready'; }, 3000);
      }
    })
    .catch(() => {
      document.getElementById('motorStatus').textContent = 'Error';
      document.getElementById('motorStatus').style.color = 'var(--danger)';
    });
  }

  // ── Save schedule ─────────────────────────────────────────────────────────
  function saveSchedule() {
    const startVal = document.getElementById('startTime').value;
    const endVal   = document.getElementById('endTime').value;
    if (!startVal || !endVal) {
      document.getElementById('scheduleStatus').textContent = 'Invalid times';
      document.getElementById('scheduleStatus').style.color = 'var(--danger)';
      return;
    }
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activation_start: startVal, activation_end: endVal })
    })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        document.getElementById('scheduleStatus').textContent = 'Saved ✓';
        document.getElementById('scheduleStatus').style.color = 'var(--accent2)';
        addLog('Schedule updated: ' + startVal + ' – ' + endVal, 'ok');
        showToast('Schedule saved: ' + startVal + ' – ' + endVal, 'success', 3000);
        setTimeout(() => { document.getElementById('scheduleStatus').textContent = 'Ready'; }, 3000);
      }
    })
    .catch(() => {
      document.getElementById('scheduleStatus').textContent = 'Error';
      document.getElementById('scheduleStatus').style.color = 'var(--danger)';
    });
  }

  // ── FPS counter ───────────────────────────────────────────────────────────
  setInterval(() => { fpsBadge.textContent = fpsCounter + ' FPS'; fpsCounter = 0; }, 1000);

  // ── Clock ─────────────────────────────────────────────────────────────────
  setInterval(() => {
    const now = new Date();
    const t   = now.toTimeString().slice(0, 8);
    camTime.textContent  = t;
    footerTime.textContent = now.toLocaleDateString('en-US', { weekday:'short', year:'numeric', month:'short', day:'numeric' }) + ' · ' + t;
  }, 1000);

  // ── Boot ──────────────────────────────────────────────────────────────────
  addLog('System initializing…', '');
  fetchDetectionState();   // sync toggle state on load
  fetchFrame();
  pollStatus();
  setInterval(pollStatus, 2000);
</script>
</body>
</html>`);
});

// ── /status ───────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cfg = readConfig();
    if (!fs.existsSync(statusFile)) {
        return res.json({
            crayfish: false, scanning: false, confidence: '', note: '',
            movement: 0, egg_color: false, snapshot_ts: 0, bbox: null, zone: '',
            zone_boundary: cfg.motor_zone_boundary || 320,
            detection_paused: detectionPaused   // <-- included in every status response
        });
    }
    try {
        const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        data.zone_boundary   = cfg.motor_zone_boundary || 320;
        data.detection_paused = detectionPaused;
        res.json(data);
    } catch (_) {
        res.json({ crayfish: false, scanning: false, detection_paused: detectionPaused });
    }
});

// ── /api/detection/toggle — pause / resume auto-detection ────────────────────
app.post('/api/detection/toggle', (req, res) => {
    detectionPaused = !detectionPaused;
    const state = detectionPaused ? 'paused' : 'active';
    console.log(`[DETECTION] Detection ${state} via dashboard.`);

    // Write a signal file so main.py can read the pause state too
    // main.py polls config_file every ~6 s; we embed the flag there
    try {
        const cfg = readConfig();
        cfg.detection_paused = detectionPaused;
        writeConfig(cfg);
    } catch (_) {}

    res.json({ ok: true, paused: detectionPaused });
});

// ── /api/detection/status ─────────────────────────────────────────────────────
app.get('/api/detection/status', (req, res) => {
    res.json({ paused: detectionPaused });
});

// ── /api/motor/run — manual stepper run ──────────────────────────────────────
app.post('/api/motor/run', (req, res) => {
    const steps     = Math.max(1, Math.min(parseInt(req.body.steps)     || 200, 9999));
    const direction = (req.body.direction || 'CW').toString().toUpperCase();

    if (!['CW', 'CCW'].includes(direction)) {
        return res.status(400).json({ ok: false, error: 'direction must be CW or CCW' });
    }

    // Write a motor command file that main.py can pick up in its loop
    const motorCmdFile = '/dev/shm/crayfish_motor_cmd.json';
    try {
        fs.writeFileSync(motorCmdFile, JSON.stringify({ steps, direction, ts: Date.now() }));
        console.log(`[MOTOR] Manual run command queued: steps=${steps} dir=${direction}`);
        res.json({ ok: true, steps, direction });
    } catch (e) {
        console.error('[MOTOR] Failed to write command file:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── /api/config ───────────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
    const existing = readConfig();
    const merged = Object.assign({}, existing, req.body);
    if (req.body.activation_start !== undefined && !req.body.activation_start) return res.json({ ok: false, error: 'Missing start time' });
    if (req.body.activation_end   !== undefined && !req.body.activation_end)   return res.json({ ok: false, error: 'Missing end time' });
    writeConfig(merged);
    console.log('Config updated:', JSON.stringify(req.body));
    res.json({ ok: true });
});

app.get('/api/config', (req, res) => res.json(readConfig()));

// ── /snapshot — live JPEG ─────────────────────────────────────────────────────
app.get('/snapshot', (req, res) => {
    if (!fs.existsSync(imageFile)) return res.status(503).send('No frame yet');
    try {
        const frame = fs.readFileSync(imageFile);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.end(frame);
    } catch (_) { res.status(503).send('Frame busy'); }
});

// ── /snapshot-captured — motion-triggered snapshot ────────────────────────────
app.get('/snapshot-captured', (req, res) => {
    if (!fs.existsSync(snapshotFile)) return res.status(404).send('No snapshot');
    try {
        const frame = fs.readFileSync(snapshotFile);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.end(frame);
    } catch (_) { res.status(503).send('Snapshot busy'); }
});

// ── /stream — MJPEG compat ────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    streamClients.add(res);
    console.log(`Stream client connected (total: ${streamClients.size})`);
    req.on('close', () => {
        streamClients.delete(res);
        console.log(`Stream client disconnected (total: ${streamClients.size})`);
    });
});

// ── /feed — manual trigger ────────────────────────────────────────────────────
app.post('/feed', (req, res) => {
    try {
        fs.writeFileSync(signalFile, 'FEED');
        console.log('Manual feed triggered from dashboard');
        res.json({ ok: true });
    } catch (e) {
        console.error('Feed signal error:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.listen(port, () => {
    console.log('Web server ready! Open your browser to http://localhost:' + port);
});
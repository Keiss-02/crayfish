require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();

const cors = require('cors');
app.use(cors());

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

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('[MongoDB] Connected'))
  .catch(e => console.error('[MongoDB] Connection error:', e));

const waterLogSchema = new mongoose.Schema({
  timestamp:     { type: Date, default: Date.now },
  turbidity_ntu: Number,
  temperature_c: Number,
  flow_lpm:      Number,
  total_liters:  Number,
  ammonia_raw:   Number,
  ammonia_status: String,
  pump_state:    String,
  uv_state:      String,
  peltier_state: String,
  valve_state:   String,
  water_status:  String,
  note:          String,
  connected:     Boolean
});

const WaterLog = mongoose.model('WaterLog', waterLogSchema);

// Save to MongoDB — called every time water status updates
async function logWaterReading(status) {
  try {
    await WaterLog.create({
      turbidity_ntu:  status.turbidity_ntu,
      temperature_c:  status.temperature_c,
      flow_lpm:       status.flow_lpm,
      total_liters:   status.total_liters,
      ammonia_raw:    status.ammonia_raw,
      ammonia_status: status.air_state || status.note,
      pump_state:     status.pump_state,
      uv_state:       status.uv_state,
      peltier_state:  status.peltier_state,
      valve_state:    status.valve_state,
      note:           status.note,
      connected:      status.connected
    });
  } catch (e) {
    console.error('[MongoDB] Log error:', e.message);
  }
}

// ── In-memory detection toggle ────────────────────────────────────────────────
let detectionPaused = false;
let lastLoggedTs = 0;

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

// ── Water dashboard ───────────────────────────────────────────────────────────
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
  const status = readJsonFile(waterStatusFile, fallback);

  // Log to MongoDB every 10 seconds max (avoid flooding)
  const now = Date.now() / 1000;
  if (status.connected && (now - lastLoggedTs) > 10) {
    lastLoggedTs = now;
    logWaterReading(status);
  }

  res.json(status);
});

// ── NEW: History endpoint ─────────────────────────────────────────────────────
app.get('/api/water/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await WaterLog.find()
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    res.json({ ok: true, count: logs.length, data: logs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
  const command = { action, value, source: 'dashboard', ts: Date.now() };
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
    res.sendFile(path.join(__dirname, 'index.html'));
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
            detection_paused: detectionPaused
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

app.post('/api/detection/toggle', (req, res) => {
    detectionPaused = !detectionPaused;
    try {
        const cfg = readConfig();
        cfg.detection_paused = detectionPaused;
        writeConfig(cfg);
    } catch (_) {}
    res.json({ ok: true, paused: detectionPaused });
});

app.get('/api/detection/status', (req, res) => {
    res.json({ paused: detectionPaused });
});

app.post('/api/motor/run', (req, res) => {
    const steps     = Math.max(1, Math.min(parseInt(req.body.steps) || 200, 9999));
    const direction = (req.body.direction || 'CW').toString().toUpperCase();
    if (!['CW', 'CCW'].includes(direction)) {
        return res.status(400).json({ ok: false, error: 'direction must be CW or CCW' });
    }
    const motorCmdFile = '/dev/shm/crayfish_motor_cmd.json';
    try {
        fs.writeFileSync(motorCmdFile, JSON.stringify({ steps, direction, ts: Date.now() }));
        res.json({ ok: true, steps, direction });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/config', (req, res) => {
    const existing = readConfig();
    const merged = Object.assign({}, existing, req.body);
    if (req.body.activation_start !== undefined && !req.body.activation_start) return res.json({ ok: false, error: 'Missing start time' });
    if (req.body.activation_end   !== undefined && !req.body.activation_end)   return res.json({ ok: false, error: 'Missing end time' });
    writeConfig(merged);
    res.json({ ok: true });
});

app.get('/api/config', (req, res) => res.json(readConfig()));

app.get('/snapshot', (req, res) => {
    if (!fs.existsSync(imageFile)) return res.status(503).send('No frame yet');
    try {
        const frame = fs.readFileSync(imageFile);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.end(frame);
    } catch (_) { res.status(503).send('Frame busy'); }
});

app.get('/snapshot-captured', (req, res) => {
    if (!fs.existsSync(snapshotFile)) return res.status(404).send('No snapshot');
    try {
        const frame = fs.readFileSync(snapshotFile);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.end(frame);
    } catch (_) { res.status(503).send('Snapshot busy'); }
});

app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    streamClients.add(res);
    req.on('close', () => { streamClients.delete(res); });
});

app.post('/feed', (req, res) => {
    try {
        fs.writeFileSync(signalFile, 'FEED');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.listen(port, () => {
    console.log(`Web server ready at http://localhost:${port}`);
});
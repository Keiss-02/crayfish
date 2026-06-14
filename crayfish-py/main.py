import cv2
import numpy as np
import time
import threading
from datetime import datetime
import os
import base64
import json
import urllib.parse
import urllib.request
import requests
from dotenv import load_dotenv
import threading

from serial_broker import MOTOR_CMD_FILE, esp32_ping, poll_command_file, send_esp32_move
from water_monitor import WaterMonitor

# ── GPIO / Motor ──────────────────────────────────────────────────────────────
try:
    from gpiozero import OutputDevice
    pin_a = OutputDevice(17)
    pin_b = OutputDevice(18)
    pin_c = OutputDevice(27)
    pin_d = OutputDevice(22)
    MOTOR_AVAILABLE = True
except Exception as e:
    print(f"Motor not available ({e}) — running in camera-test mode.")
    MOTOR_AVAILABLE = False

try:
    from picamera2 import Picamera2
except Exception:
    Picamera2 = None

load_dotenv()
signal_file           = os.getenv("SHARED_FILE")
GEMINI_API_KEY        = os.getenv("GEMINI_API_KEY")

ESP32_SERIAL_PORT    = os.getenv("ESP32_SERIAL_PORT",  "/dev/ttyUSB0").strip()
ESP32_SERIAL_BAUD    = int(os.getenv("ESP32_SERIAL_BAUD", "115200"))
ESP32_SERIAL_TIMEOUT = float(os.getenv("ESP32_SERIAL_TIMEOUT", "15"))
ESP32_STEPS           = int(os.getenv("ESP32_STEPS", "200"))
ESP32_DIRECTION       = os.getenv("ESP32_DIRECTION", "CW").strip().upper()
ACTIVATION_START      = os.getenv("ACTIVATION_START", "08:00").strip()
ACTIVATION_END        = os.getenv("ACTIVATION_END", "20:00").strip()
ROI_BOX               = os.getenv("ROI_BOX", "").strip()
MOTION_THRESHOLD      = int(os.getenv("MOTION_THRESHOLD", "5000"))
EGG_DETECT_RATIO      = float(os.getenv("EGG_DETECT_RATIO", "0.015"))
EGG_DETECT_PIXELS     = int(os.getenv("EGG_DETECT_PIXELS", "2500"))
YOLO_ENABLED          = os.getenv("YOLO_ENABLED", "false").strip().lower() in ("1", "true", "yes")
YOLO_MODEL_PATH       = os.getenv("YOLO_MODEL_PATH", "").strip()
YOLO_CONF_THRESHOLD   = float(os.getenv("YOLO_CONF_THRESHOLD", "0.4"))
REMOTE_DETECT_PROVIDER= os.getenv("REMOTE_DETECT_PROVIDER", "roboflow").strip().lower()
REMOTE_DETECT_URL     = os.getenv("REMOTE_DETECT_URL", "").strip()
REMOTE_DETECT_API_KEY = os.getenv("REMOTE_DETECT_API_KEY", "").strip()
REMOTE_DETECT_MODEL   = os.getenv("REMOTE_DETECT_MODEL", "").strip()
REMOTE_DETECT_METHOD  = os.getenv("REMOTE_DETECT_METHOD", "POST").strip().upper()
FRAME_INTERVAL        = float(os.getenv("FRAME_INTERVAL", "0.1"))
DETECTION_COOLDOWN    = float(os.getenv("DETECTION_COOLDOWN", os.getenv("GEMINI_COOLDOWN", "5")))
DETECTION_HOLD_SECS   = int(os.getenv("DETECTION_HOLD_SECS", "10"))

image_file    = "/dev/shm/crayfish_frame.jpg"
status_file   = "/dev/shm/crayfish_status.json"
config_file   = "/dev/shm/crayfish_config.json"
snapshot_file = "/dev/shm/crayfish_snapshot.jpg"

# ── Threading / timing state ──────────────────────────────────────────────────
last_feed_time       = 0
last_detection_check = 0
last_detection_time  = 0
detection_running    = False
last_snapshot_ts     = 0
detection_paused = False


def parse_time(value):
    try:
        return datetime.strptime(value, "%H:%M").time()
    except Exception:
        return None


def parse_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def load_time_config():
    """Load schedule and motor zone settings from shared config file."""
    global ACTIVATION_START, ACTIVATION_END
    global detection_paused
    global MOTOR_ZONE_BOUNDARY, MOTOR_ZONE_LEFT_STEPS, MOTOR_ZONE_LEFT_DIR
    global MOTOR_ZONE_RIGHT_STEPS, MOTOR_ZONE_RIGHT_DIR
    try:
        if os.path.exists(config_file):
            with open(config_file, 'r') as f:
                cfg = json.load(f)
            st = parse_time(cfg.get('activation_start', ''))
            et = parse_time(cfg.get('activation_end', ''))
            if st and et:
                ACTIVATION_START = st
                ACTIVATION_END   = et

            MOTOR_ZONE_BOUNDARY    = int(cfg.get('motor_zone_boundary',    320))
            MOTOR_ZONE_LEFT_STEPS  = int(cfg.get('motor_zone_left_steps',  200))
            MOTOR_ZONE_LEFT_DIR    = str(cfg.get('motor_zone_left_dir',  'CW')).upper()
            MOTOR_ZONE_RIGHT_STEPS = int(cfg.get('motor_zone_right_steps', 200))
            MOTOR_ZONE_RIGHT_DIR   = str(cfg.get('motor_zone_right_dir', 'CCW')).upper()
            detection_paused       = parse_bool(cfg.get('detection_paused', detection_paused), detection_paused)
            return
    except Exception as e:
        print(f"[CONFIG] Error: {e}")

    ACTIVATION_START = parse_time(ACTIVATION_START if isinstance(ACTIVATION_START, str) else '08:00')
    ACTIVATION_END   = parse_time(ACTIVATION_END   if isinstance(ACTIVATION_END,   str) else '20:00')
    MOTOR_ZONE_BOUNDARY    = 320
    MOTOR_ZONE_LEFT_STEPS  = int(os.getenv("ESP32_STEPS", "200"))
    MOTOR_ZONE_LEFT_DIR    = os.getenv("ESP32_DIRECTION", "CW").upper()
    MOTOR_ZONE_RIGHT_STEPS = int(os.getenv("ESP32_STEPS", "200"))
    MOTOR_ZONE_RIGHT_DIR   = os.getenv("ESP32_DIRECTION", "CW").upper()

def parse_roi_box(value):
    if not value:
        return None
    parts = [int(x) for x in value.split(",") if x.strip()]
    return tuple(parts) if len(parts) == 4 else None


load_time_config()
ROI_BOX = parse_roi_box(ROI_BOX)


def within_allowed_time():
    if ACTIVATION_START is None or ACTIVATION_END is None:
        return True
    now = datetime.now().time()
    if ACTIVATION_START <= ACTIVATION_END:
        return ACTIVATION_START <= now <= ACTIVATION_END
    return now >= ACTIVATION_START or now <= ACTIVATION_END


def frame_roi(frame):
    if ROI_BOX is None:
        return frame
    x1, y1, x2, y2 = ROI_BOX
    h, w = frame.shape[:2]
    x1, x2 = max(0, min(x1, w)), max(0, min(x2, w))
    y1, y2 = max(0, min(y1, h)), max(0, min(y2, h))
    return frame[y1:y2, x1:x2] if x1 < x2 and y1 < y2 else frame


# ── Zone classification ────────────────────────────────────────────────────────
def classify_zone(bbox, frame_width=640):
    """
    Determine which zone the crayfish bbox falls into.
    Uses the horizontal center of the bounding box relative to MOTOR_ZONE_BOUNDARY.
    Returns 'left', 'right', or '' if bbox is None.
    """
    if not bbox or len(bbox) < 4:
        return ''
    x1, y1, x2, y2 = bbox[:4]
    cx = (x1 + x2) / 2
    boundary = MOTOR_ZONE_BOUNDARY  # px in 640-wide frame
    return 'left' if cx < boundary else 'right'


# ── Egg color detection ────────────────────────────────────────────────────────
def detect_egg_colors(frame_bgr):
    roi = frame_roi(frame_bgr)
    if roi.size == 0:
        return False
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    orange_mask = cv2.inRange(hsv, (5, 120, 90), (18, 255, 255))
    brown_mask  = cv2.inRange(hsv, (10, 80, 40), (30, 255, 180))
    mask = cv2.bitwise_or(orange_mask, brown_mask)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask   = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  kernel)
    mask   = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    egg_pixels   = cv2.countNonZero(mask)
    total_pixels = roi.shape[0] * roi.shape[1]
    if total_pixels == 0 or egg_pixels == 0:
        return False

    mean_s = cv2.mean(hsv[:, :, 1], mask=mask)[0]
    mean_v = cv2.mean(hsv[:, :, 2], mask=mask)[0]
    if mean_s < 70 or mean_v < 45:
        return False

    ratio = egg_pixels / total_pixels
    return egg_pixels >= EGG_DETECT_PIXELS or ratio >= EGG_DETECT_RATIO


# ── Roboflow (primary detector) ────────────────────────────────────────────────
def detect_crayfish_remote(frame_bgr):
    if not REMOTE_DETECT_URL or not REMOTE_DETECT_MODEL:
        return False, 0.0, "", None

    if REMOTE_DETECT_PROVIDER == "roboflow":
        url = REMOTE_DETECT_URL.rstrip("/") + "/" + REMOTE_DETECT_MODEL
        if REMOTE_DETECT_API_KEY:
            url += f"?api_key={REMOTE_DETECT_API_KEY}"
        _, buf = cv2.imencode(".jpg", frame_bgr)
        b64 = base64.b64encode(buf).decode("utf-8")
        try:
            resp = requests.post(url, data=b64, headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=20)
            resp.raise_for_status()
            body = resp.json()
        except Exception as e:
            print(f"[ROBOFLOW] Request failed: {e}")
            return False, 0.0, "Remote request failed", None

        predictions = body.get("predictions") or body.get("results") or []
        # Find highest-confidence crayfish prediction
        best_conf   = 0.0
        best_pred   = None
        for pred in predictions:
            label = pred.get("class") or pred.get("label") or ""
            if "crayfish" in label.lower():
                confidence = float(pred.get("confidence", 0.0))
                if confidence > best_conf:
                    best_conf = confidence
                    best_pred = pred

        if best_pred is not None:
            label = best_pred.get("class") or best_pred.get("label") or ""
            x = best_pred.get("x"); y = best_pred.get("y")
            w = best_pred.get("width") or best_pred.get("w")
            h = best_pred.get("height") or best_pred.get("h")
            bbox = None
            if x is not None and y is not None and w is not None and h is not None:
                bbox = [int(x - w/2), int(y - h/2), int(x + w/2), int(y + h/2)]
            return True, best_conf, f"Roboflow: {label}", bbox

        return False, 0.0, "No crayfish detected", None

    print(f"[ROBOFLOW] Unsupported provider: {REMOTE_DETECT_PROVIDER}")
    return False, 0.0, "Unsupported provider", None


# ── YOLOv8 (optional local model) ─────────────────────────────────────────────
MODEL_YOLO = None
try:
    if YOLO_ENABLED:
        from ultralytics import YOLO
        YOLO_LIB_AVAILABLE = True
    else:
        YOLO_LIB_AVAILABLE = False
except Exception as e:
    print(f"[YOLO] Import failed: {e}")
    YOLO_LIB_AVAILABLE = False


def load_yolo_model():
    global MODEL_YOLO
    if not YOLO_LIB_AVAILABLE or not YOLO_ENABLED:
        return None
    path = YOLO_MODEL_PATH or "yolov8n.pt"
    try:
        MODEL_YOLO = YOLO(path)
        print(f"[YOLO] Loaded: {path}")
        return MODEL_YOLO
    except Exception as e:
        print(f"[YOLO] Failed to load {path}: {e}")
        return None


def detect_crayfish_yolo(model, frame_bgr):
    if model is None:
        return False, 0.0, None
    try:
        results = model(frame_bgr, imgsz=640, conf=YOLO_CONF_THRESHOLD)
        if not results:
            return False, 0.0, None
        res = results[0]
        for box in getattr(res, 'boxes', []):
            try:
                conf = float(box.conf[0]) if hasattr(box.conf, '__len__') else float(box.conf)
                cls  = int(box.cls[0])    if hasattr(box.cls, '__len__')  else int(box.cls)
                name = model.names.get(cls, str(cls)) if hasattr(model, 'names') else str(cls)
            except Exception:
                continue
            if 'crayfish' in name.lower():
                xy = box.xyxy[0]
                if hasattr(xy, 'cpu'):
                    xy = xy.cpu().numpy()
                return True, conf, tuple(map(int, xy[:4]))
        return False, 0.0, None
    except Exception as e:
        print(f"[YOLO] Detection error: {e}")
        return False, 0.0, None


# ── ESP32 wireless motor ───────────────────────────────────────────────────────


# ── Safe image writer ──────────────────────────────────────────────────────────
def imwrite(path, frame):
    """cv2.imwrite wrapper that works even without JPEG encoder."""
    ok, buf = cv2.imencode(".png", frame)
    if ok:
        tmp = path + ".enc.tmp"
        with open(tmp, "wb") as f:
            f.write(buf.tobytes())
        os.replace(tmp, path)
        return True
    print(f"[imwrite] Failed to encode frame for {path}")
    return False


# ── Frame helpers ──────────────────────────────────────────────────────────────
def to_bgr(raw):
    if raw.ndim == 3 and raw.shape[2] == 4:
        return cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)
    return cv2.cvtColor(raw, cv2.COLOR_RGB2BGR)


def to_gray(raw):
    if raw.ndim == 3 and raw.shape[2] == 4:
        bgr = cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return cv2.cvtColor(raw, cv2.COLOR_RGB2GRAY)


# ── Status writer ──────────────────────────────────────────────────────────────
def write_status(crayfish_detected, confidence="", note="",
                 movement=0, egg_color=False, scanning=False,
                 bbox=None, zone=""):
    payload = {
        "crayfish":    crayfish_detected,
        "confidence":  confidence,
        "note":        note,
        "movement":    movement,
        "egg_color":   egg_color,
        "scanning":    scanning,
        "bbox":        bbox,        # [x1,y1,x2,y2] or null
        "zone":        zone,        # 'left' | 'right' | ''
        "ts":          time.time(),
        "snapshot_ts": last_snapshot_ts,
    }
    tmp = status_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, status_file)


# ── Gemini (fallback when Roboflow is not configured) ─────────────────────────
def test_gemini_connection():
    if not GEMINI_API_KEY:
        print("=" * 55)
        print("  [GEMINI] ✗  GEMINI_API_KEY not set.")
        print("               Gemini fallback DISABLED.")
        print("=" * 55)
        return False

    print("  [GEMINI] Testing API connection...")
    payload = json.dumps({
        "contents": [{"parts": [{"text": "Reply with only the word PONG"}]}]
    }).encode("utf-8")
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}")
    req = urllib.request.Request(url, data=payload,
                                  headers={"Content-Type": "application/json"},
                                  method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        reply = body["candidates"][0]["content"]["parts"][0]["text"].strip()
        print("=" * 55)
        print(f"  [GEMINI] ✓  Connected — replied: '{reply}'")
        print("=" * 55)
        return True
    except Exception as e:
        print("=" * 55)
        print(f"  [GEMINI] ✗  Failed: {e}")
        print("=" * 55)
        return False


def is_crayfish_moving(frame_bgr):
    if not GEMINI_API_KEY:
        return False, "low", "No API key", None

    _, buf = cv2.imencode(".jpg", frame_bgr)
    b64    = base64.b64encode(buf).decode("utf-8")
    payload = json.dumps({"contents": [{"parts": [
        {"inline_data": {"mime_type": "image/jpeg", "data": b64}},
        {"text": (
            "This is an aquarium tank camera frame. "
            "Is a crayfish (crawfish / crawdad) visibly present and active? "
            "Reply ONLY with JSON — no markdown, no fences: "
            "{\"crayfish\": true/false, \"confidence\": \"high/medium/low\", "
            "\"note\": \"brief reason\", \"bbox\": [x1,y1,x2,y2] or null}"
        )}
    ]}]}).encode("utf-8")
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}")
    req = urllib.request.Request(url, data=payload,
                                  headers={"Content-Type": "application/json"},
                                  method="POST")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        raw_text = body["candidates"][0]["content"]["parts"][0]["text"].strip()
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]
        result = json.loads(raw_text.strip())
        detected   = result.get("crayfish", False)
        confidence = result.get("confidence", "?")
        note       = result.get("note", "")
        bbox_raw   = result.get("bbox", None)
        bbox       = bbox_raw if (isinstance(bbox_raw, list) and len(bbox_raw) == 4) else None
        print(f"[GEMINI] crayfish={detected} confidence={confidence} bbox={bbox} — {note}")
        return detected, confidence, note, bbox
    except Exception as e:
        print(f"[GEMINI] Error: {e}")
        return False, "low", str(e), None


# ── Misc helpers ───────────────────────────────────────────────────────────────
def open_picamera(max_attempts=6, retry_delay=3):
    if Picamera2 is None:
        print("Camera support not available — running without live video.")
        return None
    for attempt in range(1, max_attempts + 1):
        try:
            return Picamera2()
        except RuntimeError as e:
            print(f"Camera init attempt {attempt}/{max_attempts} failed: {e}")
            if attempt < max_attempts:
                print(f"Retrying in {retry_delay}s…")
                time.sleep(retry_delay)
    return None


def drop_food(zone=''):
    global last_feed_time

    steps     = ESP32_STEPS
    direction = ESP32_DIRECTION

    if zone == 'left':
        steps     = MOTOR_ZONE_LEFT_STEPS
        direction = MOTOR_ZONE_LEFT_DIR
    elif zone == 'right':
        steps     = MOTOR_ZONE_RIGHT_STEPS
        direction = MOTOR_ZONE_RIGHT_DIR

    print(f"[MOTOR] Sending MOVE {steps} {direction} to ESP32 (zone={zone!r})")

    if not send_esp32_move(steps, direction):
        print("[MOTOR] Serial not available — skipping feed.")

    last_feed_time = time.time()


# ── Detection thread ───────────────────────────────────────────────────────────
def run_detection(frame_bgr, movement):
    global detection_running, last_detection_time

    try:
        detected   = False
        confidence = ""
        note       = ""
        egg_color  = False
        bbox       = None
        zone       = ''

        if REMOTE_DETECT_URL and REMOTE_DETECT_MODEL:
            print("[DETECTION] Running Roboflow…")
            detected, conf_raw, note, bbox = detect_crayfish_remote(frame_bgr)
            confidence = "high" if (isinstance(conf_raw, float) and conf_raw >= 0.7) \
                         else ("medium" if isinstance(conf_raw, float) and conf_raw >= 0.4
                               else "low")
            print(f"[ROBOFLOW] detected={detected} conf={conf_raw:.2f} bbox={bbox} — {note}")
        else:
            print("[DETECTION] Roboflow not configured — using Gemini fallback…")
            detected, confidence, note, bbox = is_crayfish_moving(frame_bgr)

        if detected:
            # Determine which zone the crayfish is in
            frame_w = frame_bgr.shape[1]  # typically 640
            zone = classify_zone(bbox, frame_width=frame_w)
            print(f"[DETECTION] Crayfish confirmed — zone={zone!r}, bbox={bbox}")

            # Egg color check
            egg_color = detect_egg_colors(frame_bgr)
            if egg_color:
                print("[DETECTION] ✓ Egg colors detected!")
                note = note + "; egg-like colors present" if note else "Egg-like colors present"
            else:
                print("[DETECTION] No egg colors found.")

            last_detection_time = time.time()
            write_status(True, confidence, note, movement, egg_color,
                         scanning=False, bbox=bbox, zone=zone)

            print(f"[DETECTION] Dispensing food for zone={zone!r}!")
            drop_food(zone=zone)
        else:
            write_status(False, confidence, note, movement, egg_color=False,
                         scanning=False, bbox=None, zone='')
            print("[DETECTION] No crayfish — ignoring motion.")

    except Exception as e:
        print(f"[DETECTION THREAD] Unhandled error: {e}")
        write_status(False, note=f"Detection error: {e}", movement=movement,
                     scanning=False, bbox=None, zone='')
    finally:
        detection_running = False


# ── Main loop ──────────────────────────────────────────────────────────────────
def watch_tank():
    global last_feed_time, last_detection_check, detection_running
    global last_snapshot_ts

    print("Starting crayfish monitor…")
    print()
    print("Starting ESP32 serial link…")
    esp32_ok = esp32_ping()
    print()
    gemini_ok = test_gemini_connection()
    print()

    water_monitor = WaterMonitor().start()

    load_yolo_model()

    print("Starting camera…")
    picam2 = open_picamera()
    if picam2 is None:
        print("No camera available. Water monitoring will continue without video detection.")
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            pass
        finally:
            water_monitor.stop()
        return

    config = picam2.create_video_configuration(
        main={"size": (640, 480)},
        controls={"FrameRate": 10}
    )
    picam2.configure(config)
    picam2.start()
    print("Camera warming up…")
    time.sleep(2)

    raw        = picam2.capture_array("main")
    frame_bgr  = to_bgr(raw)
    roi_bgr    = frame_roi(frame_bgr)
    start_gray = cv2.GaussianBlur(to_gray(roi_bgr), (21, 21), 0)
    write_status(False, note="System started")
    print("Camera ready. Streaming live… (Ctrl-C to stop)")
    print(f"  Color fix: WB_BLUE_REDUCE={os.getenv('WB_BLUE_REDUCE','40')}  "
          f"WB_RED_BOOST={os.getenv('WB_RED_BOOST','20')}")
    print(f"  Zone boundary: {MOTOR_ZONE_BOUNDARY}px  "
          f"LEFT={MOTOR_ZONE_LEFT_STEPS}steps/{MOTOR_ZONE_LEFT_DIR}  "
          f"RIGHT={MOTOR_ZONE_RIGHT_STEPS}steps/{MOTOR_ZONE_RIGHT_DIR}")

    try:
        config_reload_counter = 0
        while True:
            tick = time.time()

            # ── Capture & publish live frame ───────────────────────────────────
            raw       = picam2.capture_array("main")
            frame_bgr = to_bgr(raw)
            tmp_file  = image_file.replace(".jpg", ".tmp.jpg")
            imwrite(tmp_file, frame_bgr)
            os.replace(tmp_file, image_file)

            # ── Reload schedule + motor config every ~6 s ─────────────────────
            config_reload_counter += 1
            if config_reload_counter >= 60:
                load_time_config()
                config_reload_counter = 0

            # ── Manual feed from dashboard ────────────────────────────────────
            if signal_file and os.path.exists(signal_file):
                print("Manual feed command received!")
                drop_food(zone='')   # manual feed uses default/no-zone settings
                os.remove(signal_file)

            # ── Broker motor commands from dashboard ────────────────────────
            motor_cmd = poll_command_file(MOTOR_CMD_FILE)
            if motor_cmd:
                steps = int(motor_cmd.get('steps') or ESP32_STEPS)
                direction = str(motor_cmd.get('direction') or ESP32_DIRECTION).upper()
                print(f"[BROKER] Motor command received: steps={steps} dir={direction}")
                if send_esp32_move(steps, direction):
                    last_feed_time = time.time()

            # ── Motion analysis ───────────────────────────────────────────────
            roi_bgr   = frame_roi(frame_bgr)
            gray      = cv2.GaussianBlur(to_gray(roi_bgr), (21, 21), 0)
            diff      = cv2.absdiff(start_gray, gray)
            _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
            movement  = cv2.countNonZero(thresh)

            time_since_last_meal  = time.time() - last_feed_time
            time_since_last_check = time.time() - last_detection_check

            # ── Motion triggers detection pipeline ────────────────────────────
            if (movement > MOTION_THRESHOLD
            and within_allowed_time()
            and not detection_paused          # <-- ADD THIS LINE
            and time_since_last_meal  > 300
            and time_since_last_check > DETECTION_COOLDOWN
            and not detection_running):


                print(f"[MOTION] {movement}px — saving snapshot & spawning detection…")

                tmp_snap = snapshot_file + ".tmp"
                imwrite(tmp_snap, frame_bgr.copy())
                os.replace(tmp_snap, snapshot_file)
                last_snapshot_ts = time.time()

                write_status(False, scanning=True,
                             note="Motion detected — scanning…",
                             movement=movement, bbox=None, zone='')

                last_detection_check = time.time()
                detection_running    = True

                threading.Thread(
                    target=run_detection,
                    args=(frame_bgr.copy(), movement),
                    daemon=True
                ).start()

            # ── Clear status once detection hold window expires ───────────────
            elif (movement <= MOTION_THRESHOLD
                    and not detection_running
                    and (time.time() - last_detection_time) > DETECTION_HOLD_SECS):
                write_status(False, note="No motion", movement=movement,
                             bbox=None, zone='')

            # ── Pace the loop ─────────────────────────────────────────────────
            elapsed = time.time() - tick
            if (remaining := FRAME_INTERVAL - elapsed) > 0:
                time.sleep(remaining)

    except KeyboardInterrupt:
        print("\nStopped by user.")
    finally:
        picam2.stop()
        water_monitor.stop()
        print("Camera released cleanly.")


watch_tank()
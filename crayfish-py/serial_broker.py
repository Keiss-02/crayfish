import json
import os
import threading
import time

from dotenv import load_dotenv

try:
    import serial
except Exception:  # pragma: no cover - serial is optional at import time
    serial = None


load_dotenv()

ESP32_SERIAL_PORT = os.getenv("ESP32_SERIAL_PORT", "/dev/ttyUSB0").strip()
ESP32_SERIAL_BAUD = int(os.getenv("ESP32_SERIAL_BAUD", "115200"))
ESP32_SERIAL_TIMEOUT = float(os.getenv("ESP32_SERIAL_TIMEOUT", "15"))
ESP32_STEPS = int(os.getenv("ESP32_STEPS", "200"))
ESP32_DIRECTION = os.getenv("ESP32_DIRECTION", "CW").strip().upper()

MOTOR_CMD_FILE = "/dev/shm/crayfish_motor_cmd.json"
WATER_CMD_FILE = "/dev/shm/crayfish_water_cmd.json"
BROKER_STATUS_FILE = "/dev/shm/crayfish_broker_status.json"

_esp32_serial = None
_esp32_serial_lock = threading.Lock()


def _to_float(value):
    try:
        return float(value)
    except Exception:
        return None


def _to_int(value):
    try:
        return int(float(value))
    except Exception:
        return None


def _extract_number(value):
    raw = str(value or "").strip()
    token = ""
    for ch in raw:
        if ch.isdigit() or ch in ".-":
            token += ch
        else:
            break
    return token


def _parse_status_line(line):
    if "TURBIDITY:" not in line or "TEMP:" not in line:
        return None

    pairs = {}
    for chunk in line.split("|"):
        part = chunk.strip()
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        pairs[key.strip().upper()] = value.strip()

    turbidity_raw = _to_int(_extract_number(pairs.get("TURBIDITY")))
    temp_c = _to_float(_extract_number(pairs.get("TEMP")))
    flow_lpm = _to_float(_extract_number(pairs.get("FLOW")))
    total_l = _to_float(_extract_number(pairs.get("TOTAL")))
    nh3_raw = _to_int(_extract_number(pairs.get("NH3")))

    if turbidity_raw is None and temp_c is None:
        return None

    note_parts = []
    water_state = pairs.get("WATER")
    air_state = pairs.get("AIR")
    valve_state = pairs.get("VALVE")
    if water_state:
        note_parts.append(f"Water {water_state}")
    if air_state:
        note_parts.append(f"NH3 {air_state}")
    if valve_state:
        note_parts.append(f"Valve {valve_state}")

    return {
    "temperature_c": temp_c,
    "turbidity_ntu": turbidity_raw,
    "pump_state": str(pairs.get("PUMP") or "idle").lower(),
    "flow_lpm": flow_lpm,
    "total_liters": total_l,
    "ammonia_raw": nh3_raw,
    "uv_state": str(pairs.get("UV") or "OFF").lower(),
    "peltier_state": str(pairs.get("PELTIER") or "OFF").lower(),
    "valve_state": str(valve_state or "unknown").lower(),
    "ovr_pump":    pairs.get("OVR_PUMP") == "1",
    "ovr_uv":      pairs.get("OVR_UV") == "1",
    "ovr_peltier": pairs.get("OVR_PELTIER") == "1",
    "ovr_valve":   pairs.get("OVR_VALVE") == "1",
    "note": " | ".join(note_parts) if note_parts else "Live telemetry",
    "raw_line": line,
}


def _atomic_write(path, payload):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as handle:
        json.dump(payload, handle)
    os.replace(tmp_path, path)


def enqueue_command(path, payload):
    payload = dict(payload or {})
    payload.setdefault("ts", time.time())
    _atomic_write(path, payload)


def poll_command_file(path):
    if not os.path.exists(path):
        return None

    try:
        with open(path, "r") as handle:
            payload = json.load(handle)
    except Exception as exc:
        print(f"[BROKER] Failed to read {path}: {exc}")
        try:
            os.remove(path)
        except Exception:
            pass
        return None

    try:
        os.remove(path)
    except Exception:
        pass

    return payload


def record_broker_status(payload):
    payload = dict(payload or {})
    payload.setdefault("ts", time.time())
    try:
        _atomic_write(BROKER_STATUS_FILE, payload)
    except Exception as exc:
        print(f"[BROKER] Failed to write status: {exc}")


def describe_broker_state():
    return {
        "serial_port": ESP32_SERIAL_PORT,
        "serial_baud": ESP32_SERIAL_BAUD,
        "serial_timeout": ESP32_SERIAL_TIMEOUT,
        "connected": _esp32_serial is not None and _esp32_serial.is_open,
    }


def get_esp32_serial():
    """
    Return an open serial connection to the ESP32.
    Thread-safe via _esp32_serial_lock (caller must already hold it).
    """
    global _esp32_serial

    if serial is None:
        print("[BROKER] pyserial is not available.")
        return None

    if _esp32_serial is not None and _esp32_serial.is_open:
        return _esp32_serial

    if not ESP32_SERIAL_PORT:
        print("[BROKER] ESP32_SERIAL_PORT not set — serial disabled.")
        return None

    try:
        ser = serial.Serial(
            port=ESP32_SERIAL_PORT,
            baudrate=ESP32_SERIAL_BAUD,
            timeout=ESP32_SERIAL_TIMEOUT,
            write_timeout=5,
        )
        time.sleep(2)
        ser.reset_input_buffer()

        _esp32_serial = ser
        print(f"[BROKER] Serial opened: {ESP32_SERIAL_PORT} @ {ESP32_SERIAL_BAUD} baud")
        return ser
    except Exception as exc:
        print(f"[BROKER] Cannot open {ESP32_SERIAL_PORT}: {exc}")
        _esp32_serial = None
        return None


def _close_serial():
    global _esp32_serial
    try:
        if _esp32_serial and _esp32_serial.is_open:
            _esp32_serial.close()
    except Exception:
        pass
    _esp32_serial = None


def send_raw_command(command, expect_reply_lines=2, label="BROKER"):
    command = str(command).strip()
    if not command:
        return False

    with _esp32_serial_lock:
        ser = get_esp32_serial()
        if ser is None:
            print(f"[{label}] Serial not available — skipping command: {command}")
            return False

        try:
            ser.reset_input_buffer()
            ser.write((command + "\n").encode("utf-8"))
            ser.flush()
            print(f"[{label}] Sent: {command}")

            replies = []
            for _ in range(max(1, int(expect_reply_lines))):
                reply = ser.readline().decode("utf-8", errors="replace").strip()
                if reply:
                    replies.append(reply)
                if reply.startswith("DONE:") or reply.startswith("ERR:"):
                    break

            if replies:
                print(f"[{label}] Replies: {' | '.join(replies)}")
            return True
        except Exception as exc:
            print(f"[{label}] Serial command failed: {exc}")
            _close_serial()
            return False


def read_water_telemetry(max_lines=12):
    with _esp32_serial_lock:
        ser = get_esp32_serial()
        if ser is None:
            return None

        latest_payload = None
        lines_read = 0

        try:
            available = ser.in_waiting if hasattr(ser, "in_waiting") else 0
        except Exception:
            available = 0

        if available <= 0:
            return None

        try:
            while lines_read < max_lines:
                if hasattr(ser, "in_waiting") and ser.in_waiting <= 0:
                    break

                raw = ser.readline().decode("utf-8", errors="replace").strip()
                lines_read += 1
                if not raw:
                    continue

                payload = _parse_status_line(raw)
                if payload:
                    latest_payload = payload

            return latest_payload
        except Exception as exc:
            print(f"[WATER] Telemetry read failed: {exc}")
            _close_serial()
            return None


def esp32_ping():
    with _esp32_serial_lock:
        ser = get_esp32_serial()
        if ser is None:
            print("[BROKER] ✗ Serial not available — skipping ping.")
            return False

        try:
            ser.reset_input_buffer()
            ser.write(b"PING\n")
            ser.flush()
            reply = ser.readline().decode("utf-8", errors="replace").strip()
            if reply == "PONG":
                print(f"[BROKER] ✓ Ping OK -> {reply}")
                return True

            print(f"[BROKER] ✗ Unexpected ping reply: {reply!r}")
            return False
        except Exception as exc:
            print(f"[BROKER] Ping failed: {exc}")
            _close_serial()
            return False


def send_esp32_move(steps=None, direction=None):
    steps = int(steps or ESP32_STEPS)
    direction = (direction or ESP32_DIRECTION).upper()
    command = f"MOVE {steps} {direction}"
    return send_raw_command(command, expect_reply_lines=2, label="MOTOR")


def send_water_command(action, value=None):
    # If already a raw ESP32 command string, send directly
    raw_commands = {
        "UV_ON", "UV_OFF", "VALVE_ON", "VALVE_OFF",
        "COOL_MAX", "COOL_OFF", "PUMP_ON", "PUMP_OFF",
        "RESET_OVERRIDE", "RESET_PUMP", "RESET_UV",
        "RESET_PELTIER", "RESET_VALVE"
    }

    action_str = str(action or "").strip()

    if action_str.upper() in raw_commands:
        return send_raw_command(action_str.upper(), expect_reply_lines=2, label="WATER")

    action_normalized = action_str.lower()
    value_text = str(value).strip().upper() if value is not None else ""

    if action_normalized in ("refresh", "status", "read"):
        return True

    if action_normalized == "pump":
        command = "PUMP_ON" if value_text == "ON" else "PUMP_OFF"
    else:
        command = f"{action_str.upper()} {value_text}".strip()

    return send_raw_command(command, expect_reply_lines=2, label="WATER")

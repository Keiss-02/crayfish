import json
import os
import threading
import time

from serial_broker import (
    WATER_CMD_FILE,
    describe_broker_state,
    poll_command_file,
    read_water_telemetry,
    record_broker_status,
    send_water_command,
)


WATER_STATUS_FILE = "/dev/shm/crayfish_water_status.json"


def _atomic_write(path, payload):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as handle:
        json.dump(payload, handle)
    os.replace(tmp_path, path)


def _default_status():
    broker_state = describe_broker_state()
    return {
        "connected": False,
        "note": "Waiting for water monitor",
        "serial_port": broker_state.get("serial_port"),
        "temperature_c": None,
        "ph": None,
        "turbidity_ntu": None,
        "tds_ppm": None,
        "level_pct": None,
        "pump_state": "idle",
        "last_command": None,
        "last_reply": None,
        "last_update": None,
        "ts": time.time(),
    }


def read_water_status():
    if not os.path.exists(WATER_STATUS_FILE):
        return _default_status()

    try:
        with open(WATER_STATUS_FILE, "r") as handle:
            payload = json.load(handle)
        status = _default_status()
        status.update(payload if isinstance(payload, dict) else {})
        return status
    except Exception:
        return _default_status()


def write_water_status(payload):
    status = _default_status()
    status.update(payload if isinstance(payload, dict) else {})
    status["ts"] = time.time()
    _atomic_write(WATER_STATUS_FILE, status)


def handle_water_command(command, status):
    action = str(command.get("action") or command.get("type") or "refresh").strip().lower()
    value = command.get("value")
    status = dict(status)
    status["last_command"] = command
    status["connected"] = describe_broker_state().get("connected", False)

    if action in ("refresh", "status", "read"):
        status["note"] = "Water status refreshed"
        status["last_reply"] = "REFRESH"
        return status

    # Map dashboard actions to ESP32 commands
    action_to_cmd = {
        "uv_on":    "UV_ON",
        "uv_off":   "UV_OFF",
        "valve_on": "VALVE_ON",
        "valve_off":"VALVE_OFF",
        "cool_max": "COOL_MAX",
        "cool_off": "COOL_OFF",
        "pump_on":  "PUMP_ON",
        "pump_off": "PUMP_OFF",
        "reset_override":  "RESET_OVERRIDE",
        "reset_pump":      "RESET_PUMP",
        "reset_uv":        "RESET_UV",
        "reset_peltier":   "RESET_PELTIER",
        "reset_valve":     "RESET_VALVE",
    }

    if action == "pump_toggle":
        pump_state = str(status.get("pump_state") or "idle").lower()
        action = "pump_on" if pump_state != "on" else "pump_off"

    if action in action_to_cmd:
        esp_cmd = action_to_cmd[action]
        reply_ok = send_water_command(esp_cmd, None)

        # Update local status optimistically
        if action == "pump_on":    status["pump_state"]    = "on"
        if action == "pump_off":   status["pump_state"]    = "off"
        if action == "uv_on":      status["uv_state"]      = "on"
        if action == "uv_off":     status["uv_state"]      = "off"
        if action == "valve_on":   status["valve_state"]   = "open"
        if action == "valve_off":  status["valve_state"]   = "closed"
        if action == "cool_max":   status["peltier_state"] = "on"
        if action == "cool_off":   status["peltier_state"] = "off"

        status["last_reply"] = "OK" if reply_ok else "FAILED"
        status["note"] = f"Manual override: {esp_cmd}"
        return status

    # Fallback — send raw
    reply_ok = send_water_command(action, value)
    status["last_reply"] = "OK" if reply_ok else "FAILED"
    status["note"] = f"Processed water command: {action}"
    return status


class WaterMonitor:
    def __init__(self, interval_seconds=2.5):
        self.interval_seconds = float(interval_seconds)
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return self
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

    def _run(self):
        while not self._stop_event.is_set():
            try:
                status = read_water_status()
                broker_state = describe_broker_state()
                status["connected"] = broker_state.get("connected", False)
                status["serial_port"] = broker_state.get("serial_port")
                status["last_update"] = time.time()
                status.setdefault("note", "Water monitor running")

                command = poll_command_file(WATER_CMD_FILE)
                if command:
                    status = handle_water_command(command, status)

                telemetry = read_water_telemetry()
                if telemetry:
                    status.update(telemetry)
                    status["connected"] = True
                    status["last_reply"] = f"T:{telemetry.get('temperature_c','?')}°C | NH3:{telemetry.get('ammonia_raw','?')} | Pump:{telemetry.get('pump_state','?').upper()}"

                write_water_status(status)
                record_broker_status({
                    "channel": "water",
                    "connected": status.get("connected", False),
                    "note": status.get("note", ""),
                    "last_update": status.get("last_update"),
                })
            except Exception as exc:
                write_water_status({
                    **read_water_status(),
                    "note": f"Water monitor error: {exc}",
                    "connected": False,
                    "last_update": time.time(),
                })

            self._stop_event.wait(self.interval_seconds)
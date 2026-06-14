"""
esp32_serial_patch.py
─────────────────────
Drop-in replacement for the HTTP-based ESP32 functions in main.py.
Paste these blocks into main.py, replacing the existing send_esp32_move()
and any HTTP-related ESP32 imports.

Changes summary:
  1. Adds pyserial import + serial env vars
  2. Replaces HTTP send_esp32_move() with serial version
  3. Adds get_esp32_serial() for lazy connection + auto-reconnect
  4. Adds esp32_ping() health check called at startup
  5. .env keys changed:  ESP32_HOST/PORT/PATH  →  ESP32_SERIAL_PORT / ESP32_SERIAL_BAUD
"""

# ─────────────────────────────────────────────────────────────────────────────
# 1. IMPORTS  — add these near the top of main.py
#    (remove urllib.parse / urllib.request if no longer needed elsewhere)
# ─────────────────────────────────────────────────────────────────────────────
import serial                      # pip install pyserial
import threading

# ─────────────────────────────────────────────────────────────────────────────
# 2. ENV VARS  — add/replace in main.py after load_dotenv()
#    Remove: ESP32_HOST, ESP32_PORT, ESP32_PATH
#    Keep:   ESP32_STEPS, ESP32_DIRECTION
# ─────────────────────────────────────────────────────────────────────────────
import os
from dotenv import load_dotenv
load_dotenv()

ESP32_SERIAL_PORT  = os.getenv("ESP32_SERIAL_PORT",  "/dev/ttyUSB0").strip()
ESP32_SERIAL_BAUD  = int(os.getenv("ESP32_SERIAL_BAUD", "115200"))
ESP32_SERIAL_TIMEOUT = float(os.getenv("ESP32_SERIAL_TIMEOUT", "15"))  # seconds to wait for DONE
ESP32_STEPS        = int(os.getenv("ESP32_STEPS",     "200"))
ESP32_DIRECTION    = os.getenv("ESP32_DIRECTION",    "CW").strip().upper()

# ─────────────────────────────────────────────────────────────────────────────
# 3. SERIAL CONNECTION  — add these globals + functions in main.py
# ─────────────────────────────────────────────────────────────────────────────

_esp32_serial      = None
_esp32_serial_lock = threading.Lock()


def get_esp32_serial() -> "serial.Serial | None":
    """
    Return an open serial connection to the ESP32.
    Creates a new connection if not yet opened or if the port closed.
    Thread-safe via _esp32_serial_lock (caller must already hold it).
    """
    global _esp32_serial

    # Already open?
    if _esp32_serial is not None and _esp32_serial.is_open:
        return _esp32_serial

    if not ESP32_SERIAL_PORT:
        print("[ESP32] ESP32_SERIAL_PORT not set — serial disabled.")
        return None

    try:
        ser = serial.Serial(
            port=ESP32_SERIAL_PORT,
            baudrate=ESP32_SERIAL_BAUD,
            timeout=ESP32_SERIAL_TIMEOUT,
            write_timeout=5,
        )
        # ESP32 resets on serial open; wait for ready banner
        import time
        time.sleep(2)
        ser.reset_input_buffer()

        _esp32_serial = ser
        print(f"[ESP32] Serial opened: {ESP32_SERIAL_PORT} @ {ESP32_SERIAL_BAUD} baud")
        return ser

    except serial.SerialException as e:
        print(f"[ESP32] Cannot open {ESP32_SERIAL_PORT}: {e}")
        _esp32_serial = None
        return None


def _close_serial():
    """Close and discard the serial connection so next call reconnects."""
    global _esp32_serial
    try:
        if _esp32_serial and _esp32_serial.is_open:
            _esp32_serial.close()
    except Exception:
        pass
    _esp32_serial = None


# ─────────────────────────────────────────────────────────────────────────────
# 4. PING  — call once at startup (replaces test_gemini-style check for ESP32)
# ─────────────────────────────────────────────────────────────────────────────

def esp32_ping() -> bool:
    """
    Send a PING to the ESP32 and verify PONG reply.
    Returns True if the ESP32 is responsive.
    """
    with _esp32_serial_lock:
        ser = get_esp32_serial()
        if ser is None:
            print("[ESP32] ✗ Serial not available — skipping ping.")
            return False
        try:
            ser.reset_input_buffer()
            ser.write(b"PING\n")
            ser.flush()
            reply = ser.readline().decode("utf-8", errors="replace").strip()
            if reply == "PONG":
                print(f"[ESP32] ✓ Ping OK → {reply}")
                return True
            else:
                print(f"[ESP32] ✗ Unexpected ping reply: {reply!r}")
                return False
        except Exception as e:
            print(f"[ESP32] Ping failed: {e}")
            _close_serial()
            return False


# ─────────────────────────────────────────────────────────────────────────────
# 5. SEND MOVE  — replaces the HTTP-based send_esp32_move() in main.py
# ─────────────────────────────────────────────────────────────────────────────

def send_esp32_move(steps: int = None, direction: str = None) -> bool:
    """
    Send a MOVE command to the ESP32 over USB serial.
    Blocks until the ESP32 replies DONE (motor finished) or timeout.
    Returns True on success.
    """
    steps     = int(steps or ESP32_STEPS)
    direction = (direction or ESP32_DIRECTION).upper()
    cmd       = f"MOVE:{steps}:{direction}\n".encode("utf-8")

    with _esp32_serial_lock:
        ser = get_esp32_serial()
        if ser is None:
            print("[ESP32] No serial connection — skipping motor move.")
            return False

        try:
            ser.reset_input_buffer()
            ser.write(cmd)
            ser.flush()
            print(f"[ESP32] Sent: MOVE:{steps}:{direction}")

            # — Wait for ACK ──────────────────────────────────────────────────
            ack = ser.readline().decode("utf-8", errors="replace").strip()
            if not ack.startswith("ACK:"):
                print(f"[ESP32] Unexpected ACK: {ack!r}")
                if ack.startswith("ERR:"):
                    return False
                # Maybe it's a startup banner — try one more line
                ack = ser.readline().decode("utf-8", errors="replace").strip()

            print(f"[ESP32] ACK: {ack}")

            # — Wait for DONE (blocking while motor runs) ────────────────────
            # ser.timeout already set to ESP32_SERIAL_TIMEOUT seconds
            done = ser.readline().decode("utf-8", errors="replace").strip()
            print(f"[ESP32] {done}")

            if done.startswith("DONE:"):
                return True
            else:
                print(f"[ESP32] Unexpected DONE reply: {done!r}")
                return False

        except serial.SerialTimeoutException:
            print("[ESP32] Timeout waiting for DONE — motor may still be running.")
            _close_serial()
            return False
        except serial.SerialException as e:
            print(f"[ESP32] Serial error: {e}")
            _close_serial()
            return False
        except Exception as e:
            print(f"[ESP32] Unexpected error: {e}")
            _close_serial()
            return False


# ─────────────────────────────────────────────────────────────────────────────
# 6. HOW TO INTEGRATE INTO watch_tank()
# ─────────────────────────────────────────────────────────────────────────────
#
# In watch_tank(), near the top where gemini_ok = test_gemini_connection():
#
#     print("Starting ESP32 serial link…")
#     esp32_ok = esp32_ping()
#     if not esp32_ok:
#         print("[WARN] ESP32 not responding — food dispenser disabled until reconnect.")
#     print()
#
# Everything else (drop_food, run_detection) calls send_esp32_move() exactly
# as before — no other changes needed.
# ─────────────────────────────────────────────────────────────────────────────


# ── Minimal self-test (run this file directly on the Pi to verify wiring) ─────
if __name__ == "__main__":
    import time

    print("=== ESP32 Serial Self-Test ===")
    print(f"Port: {ESP32_SERIAL_PORT}  Baud: {ESP32_SERIAL_BAUD}")
    print()

    if esp32_ping():
        print("\n[TEST] Sending MOVE:100:CW …")
        ok = send_esp32_move(steps=100, direction="CW")
        print(f"[TEST] Move CW result: {'OK' if ok else 'FAILED'}")

        time.sleep(1)

        print("\n[TEST] Sending MOVE:100:CCW …")
        ok = send_esp32_move(steps=100, direction="CCW")
        print(f"[TEST] Move CCW result: {'OK' if ok else 'FAILED'}")
    else:
        print("[TEST] Ping failed — check cable and port.")

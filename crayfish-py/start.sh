#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Crayfish Monitor — safe startup script
# ─────────────────────────────────────────────────────────────

echo "Stopping any old monitor processes..."
pkill -f "python3 main.py" 2>/dev/null && sleep 1 || true
pkill -f "rpicam"          2>/dev/null && sleep 1 || true
pkill -f "libcamera"       2>/dev/null && sleep 1 || true

# Pi 5 camera stack uses /dev/media* AND /dev/video* — release all of them
echo "Releasing all camera devices..."
for dev in /dev/media* /dev/video*; do
    sudo fuser -k "$dev" 2>/dev/null || true
done
sleep 2   # give the kernel time to fully release the pipeline

echo "Starting crayfish monitor..."
exec python3 main.py
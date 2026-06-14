import cv2
import os
import time
from dotenv import load_dotenv
import numpy as np

load_dotenv()
IMAGE_FILE = os.getenv('IMAGE_FILE', '/dev/shm/crayfish_frame.jpg')

# Default trackbar values (sensible starting point for orange/brown eggs)
defaults = {
    'h_low': int(os.getenv('EGG_H_LOW', '5')),
    'h_high': int(os.getenv('EGG_H_HIGH', '18')),
    's_low': int(os.getenv('EGG_S_LOW', '120')),
    's_high': int(os.getenv('EGG_S_HIGH', '255')),
    'v_low': int(os.getenv('EGG_V_LOW', '90')),
    'v_high': int(os.getenv('EGG_V_HIGH', '255')),
}

WINDOW = 'Egg HSV Tuner'
cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
cv2.resizeWindow(WINDOW, 1000, 600)

# create trackbars
cv2.createTrackbar('H Low', WINDOW, defaults['h_low'], 179, lambda v: None)
cv2.createTrackbar('H High', WINDOW, defaults['h_high'], 179, lambda v: None)
cv2.createTrackbar('S Low', WINDOW, defaults['s_low'], 255, lambda v: None)
cv2.createTrackbar('S High', WINDOW, defaults['s_high'], 255, lambda v: None)
cv2.createTrackbar('V Low', WINDOW, defaults['v_low'], 255, lambda v: None)
cv2.createTrackbar('V High', WINDOW, defaults['v_high'], 255, lambda v: None)

print('Controls: adjust sliders. Press s to save, q or ESC to quit.')

def read_frame():
    # Prefer reading a live image file written by the Python detector; fall back to webcam 0.
    if os.path.exists(IMAGE_FILE):
        try:
            img = cv2.imread(IMAGE_FILE)
            if img is not None:
                return img
        except Exception:
            pass
    # try webcam
    cap = cv2.VideoCapture(0)
    if cap.isOpened():
        ret, frame = cap.read()
        cap.release()
        if ret:
            return frame
    return None

while True:
    frame = read_frame()
    if frame is None:
        blank = 255 * np.ones((480, 640, 3), dtype=np.uint8)
        cv2.putText(blank, 'No frame available - place /dev/shm/crayfish_frame.jpg or connect a webcam', (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0,0,0), 1)
        cv2.imshow(WINDOW, blank)
        key = cv2.waitKey(200) & 0xFF
        if key in (27, ord('q')):
            break
        continue

    h_low = cv2.getTrackbarPos('H Low', WINDOW)
    h_high = cv2.getTrackbarPos('H High', WINDOW)
    s_low = cv2.getTrackbarPos('S Low', WINDOW)
    s_high = cv2.getTrackbarPos('S High', WINDOW)
    v_low = cv2.getTrackbarPos('V Low', WINDOW)
    v_high = cv2.getTrackbarPos('V High', WINDOW)

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    lower = np.array([h_low, s_low, v_low], dtype=np.uint8)
    upper = np.array([h_high, s_high, v_high], dtype=np.uint8)
    mask = cv2.inRange(hsv, lower, upper)

    # morphological cleanup
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5,5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    egg_pixels = int(cv2.countNonZero(mask))
    total_pixels = frame.shape[0] * frame.shape[1]
    ratio = egg_pixels / total_pixels

    # overlay mask on image for preview
    mask_colored = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
    overlay = cv2.addWeighted(frame, 0.7, mask_colored, 0.3, 0)

    info = f'Pixels={egg_pixels} Ratio={ratio:.4f} H[{h_low}-{h_high}] S[{s_low}-{s_high}] V[{v_low}-{v_high}]'
    cv2.putText(overlay, info, (8, overlay.shape[0]-10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,255,255), 1)

    combined = np.hstack((cv2.resize(frame, (480,360)), cv2.resize(overlay, (480,360)), cv2.resize(cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR), (480,360))))
    cv2.imshow(WINDOW, combined)

    key = cv2.waitKey(100) & 0xFF
    if key == ord('s'):
        # save to .env.tuned
        lines = [
            f'EGG_H_LOW={h_low}',
            f'EGG_H_HIGH={h_high}',
            f'EGG_S_LOW={s_low}',
            f'EGG_S_HIGH={s_high}',
            f'EGG_V_LOW={v_low}',
            f'EGG_V_HIGH={v_high}',
        ]
        with open('.env.tuned', 'w') as f:
            f.write('\n'.join(lines) + '\n')
        print('Saved tuned values to .env.tuned')
    if key in (27, ord('q')):
        break

cv2.destroyAllWindows()

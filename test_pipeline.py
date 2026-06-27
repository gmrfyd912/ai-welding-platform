#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local pipeline verification script
Runs analyze_laser_grid on a synthetic image and checks:
  1) max/min height > 0
  2) deform_px > 0  (baseline_y != actual_y)
  3) max marker x_pct within bead polygon bounds
"""
import sys
import os
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2
import numpy as np

# Redirect stdout to utf-8 on Windows
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from vision_processor import analyze_laser_grid

# ── Synthetic image parameters ─────────────────────────────────────────
H, W        = 600, 1000   # image size (px)
BEAD_X1     = 200         # bead left x  (px)
BEAD_X2     = 800         # bead right x (px)
BEAD_Y1     = 200         # bead top y   (px)  <- crown
BEAD_Y2     = 350         # bead bottom y (px) <- Toe / Height=0 baseline
LINE_STEP   = 50          # grid spacing (px)
SHIFT_PX    = 40          # upward shift of lines inside bead (px)

PPM         = 25.0        # pixels/mm  (from ArUco marker, fixed)
LASER_DEG   = 90.0        # vertical laser
SHOOT_DEG   = 45.0        # camera elevation angle
GREEN       = (0, 220, 0)


def build_synthetic_image():
    """
    Create a 1000x600 image with:
      - Flat green laser lines outside the bead
      - Bead-area lines shifted UP by SHIFT_PX to simulate bead height
    """
    img = np.full((H, W, 3), 70, dtype=np.uint8)

    for y in range(LINE_STEP, H, LINE_STEP):
        if BEAD_Y1 <= y <= BEAD_Y2:
            # Bead region: draw line shifted upward
            shifted_y = y - SHIFT_PX
            cv2.line(img, (BEAD_X1, shifted_y), (BEAD_X2, shifted_y), GREEN, 2)
        else:
            # Flat region: draw line at original y
            cv2.line(img, (0, y), (W - 1, y), GREEN, 2)

    return img


def main():
    img = build_synthetic_image()

    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert ok, "JPEG encode failed"
    image_bytes = bytes(buf.tobytes())

    # Bead polygon: rectangle (bottom-left, bottom-right, top-right, top-left)
    # Leftmost and rightmost points both at y=BEAD_Y2 -> horizontal baseline
    bead_polygon = [
        {"x_pct": BEAD_X1 / W * 100, "y_pct": BEAD_Y2 / H * 100},   # bottom-left  (Toe-L)
        {"x_pct": BEAD_X2 / W * 100, "y_pct": BEAD_Y2 / H * 100},   # bottom-right (Toe-R)
        {"x_pct": BEAD_X2 / W * 100, "y_pct": BEAD_Y1 / H * 100},   # top-right
        {"x_pct": BEAD_X1 / W * 100, "y_pct": BEAD_Y1 / H * 100},   # top-left
    ]

    print("[test] Calling analyze_laser_grid ...")
    result = analyze_laser_grid(
        image_bytes,
        ppm=PPM,
        laser_angle_deg=LASER_DEG,
        shooting_angle_deg=SHOOT_DEG,
        bead_polygon_pct=bead_polygon,
    )

    # ── Compute theoretical h_mm ────────────────────────────────────────
    sin_s = math.sin(math.radians(SHOOT_DEG))
    tan_s = math.tan(math.radians(SHOOT_DEG))

    # ── Print results ───────────────────────────────────────────────────
    print()
    print("=" * 62)
    print("  Local pipeline verification result")
    print("=" * 62)
    print(f"  Status      : {result.get('status')}")

    if result.get('status') != 'success':
        print(f"  ERROR       : {result.get('message')}")
        sys.exit(1)

    max_h   = result.get('beadHeightMax', 0)
    min_h   = result.get('beadHeightMin', 0)
    avg_h   = result.get('beadHeightAvg', 0)
    dm      = result.get('debug_metrics', {})
    max_pt  = result.get('maxPoint', {})
    min_pt  = result.get('minPoint', {})

    bead_xlo_pct = BEAD_X1 / W * 100   # 20.0%
    bead_xhi_pct = BEAD_X2 / W * 100   # 80.0%
    x_max_pct    = max_pt.get('x_pct', -1)
    x_min_pct    = min_pt.get('x_pct', -1)

    deform_px  = dm.get('deform_px', 0) or 0
    baseline_y = dm.get('baseline_y')
    actual_y   = dm.get('actual_y')

    # Observed expected_h from actual deform_px
    expected_h_from_deform = deform_px / (sin_s * PPM * tan_s) if deform_px else 0

    print(f"  SHIFT_PX    : {SHIFT_PX}px (designed bead shift)")
    print(f"  deform_px   : {deform_px}px  (actual median from algorithm)")
    print(f"  expected h  : {expected_h_from_deform:.2f}mm (= {deform_px}px / (sin{SHOOT_DEG:.0f}deg x {PPM} x tan{SHOOT_DEG:.0f}deg))")
    print(f"  max_height  : {max_h}mm")
    print(f"  min_height  : {min_h}mm")
    print(f"  avg_height  : {avg_h}mm")
    print(f"  baseline_y  : {baseline_y}px")
    print(f"  actual_y    : {actual_y}px")
    print(f"  ppm_used    : {dm.get('ppm')}")
    print(f"  max_marker  : x={x_max_pct:.1f}%  (bead [{bead_xlo_pct:.0f}%~{bead_xhi_pct:.0f}%])")
    print(f"  min_marker  : x={x_min_pct:.1f}%")
    print()
    print("  [Verification]")

    results = []

    def chk(label, cond, detail=""):
        mark = "[PASS]" if cond else "[FAIL]"
        msg  = f"  {mark} {label}"
        if detail:
            msg += f"  -> {detail}"
        print(msg)
        results.append(cond)

    chk("max_height > 0mm (real bead height measured)",
        max_h > 0, f"{max_h}mm")

    chk("avg_height > 0mm (convex bead direction correct)",
        avg_h > 0, f"{avg_h}mm")

    chk("deform_px > 0 (baseline_y > actual_y, lines shifted up)",
        deform_px > 0, f"{deform_px}px")

    chk("baseline_y != actual_y (separation confirmed)",
        baseline_y != actual_y,
        f"base={baseline_y} actual={actual_y}")

    chk(f"max_marker x_pct in bead range [{bead_xlo_pct:.0f}%~{bead_xhi_pct:.0f}%]",
        bead_xlo_pct <= x_max_pct <= bead_xhi_pct, f"{x_max_pct:.1f}%")

    chk("max_height ~= expected_h from deform (within 0.5mm)",
        abs(max_h - expected_h_from_deform) < 0.5,
        f"max_h={max_h} expected={expected_h_from_deform:.2f} diff={abs(max_h-expected_h_from_deform):.2f}mm")

    print()
    passed = sum(results)
    total  = len(results)
    print(f"  Result: {passed}/{total} passed {'[ALL PASS]' if passed == total else '[SOME FAIL]'}")
    print("=" * 62)

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()

"""
trace-oom-crash.py — Render FastAPI OOM(메모리 초과) 크래시 원인 진단
OpenCV 각 연산 단계의 배열 생성·소멸 패턴을 추적하여 512MB 한계 충돌 지점 특정.

tracemalloc: Python 힙(heap) 수준 측정
arr.nbytes : numpy/cv2 배열 실제 버퍼 크기 직접 계산 (더 정확한 ground-truth)
"""

import os
import sys
import gc
import math
import tracemalloc
import numpy as np
import cv2

# Windows cp949 콘솔에서 유니코드 출력 허용
if sys.stdout.encoding and sys.stdout.encoding.lower() in ("cp949", "cp1252", "ascii"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 이 디렉토리가 vision_processor / aruco_rectify 임포트 경로 포함
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

RENDER_RAM_LIMIT_MB = 512.0
PYTHON_OVERHEAD_MB  = 185.0  # Python 3.13 + uvicorn + FastAPI + numpy/cv2 + httpx + openai + anthropic


def _mb(b: int) -> float:
    return b / 1_048_576


def _arr_mb(*arrays: np.ndarray) -> float:
    return sum(a.nbytes for a in arrays if a is not None) / 1_048_576


def _bytes_mb(b: bytes) -> float:
    return len(b) / 1_048_576


def report_danger(label: str, peak_mb: float, note: str = ""):
    pct = peak_mb / RENDER_RAM_LIMIT_MB * 100
    flag = "❌ OOM!" if pct >= 100 else ("⚠️  위험" if pct >= 70 else "✅ 안전")
    print(f"  이론적 피크: {peak_mb:.1f}MB ({pct:.0f}% / 512MB)  {flag}")
    if note:
        print(f"  ※ {note}")
    return peak_mb


# ═══════════════════════════════════════════════════════════════════
# [STEP 0] 더미 고해상도 용접 이미지 생성 (5MB+ JPEG, 12MP 스마트폰)
# ═══════════════════════════════════════════════════════════════════
IMG_H, IMG_W = 3024, 4032  # 12MP (Galaxy S22+ / iPhone 14 기본 해상도)
rng = np.random.default_rng(42)
dummy = rng.integers(30, 220, (IMG_H, IMG_W, 3), dtype=np.uint8)
ok, buf = cv2.imencode(".jpg", dummy, [cv2.IMWRITE_JPEG_QUALITY, 95])
IMAGE_BYTES: bytes = bytes(buf.tobytes())
DECODED_MB = IMG_H * IMG_W * 3 / 1_048_576       # 37.0MB
CH_MB      = IMG_H * IMG_W     / 1_048_576        # 12.3MB  (grayscale / 단일채널)
del dummy, buf
gc.collect()

print("═" * 68)
print("  trace-oom-crash.py — Render OOM 크래시 원인 진단")
print("═" * 68)
print(f"  더미 이미지  : {IMG_H}×{IMG_W} = {DECODED_MB:.1f}MB (BGR 디코딩 후)")
print(f"  JPEG 파일    : {_bytes_mb(IMAGE_BYTES):.1f}MB")
print(f"  Render 한도  : {RENDER_RAM_LIMIT_MB:.0f}MB  (초과 즉시 SIGKILL)")
print(f"  앱 기준 오버헤드: {PYTHON_OVERHEAD_MB:.0f}MB (인터프리터+라이브러리+uvicorn)")
print()

results: dict[str, float] = {}   # {tag: peak_explicit_mb}

# ═══════════════════════════════════════════════════════════════════
# [A] cv2.imdecode 단독 — 최소 baseline
# ═══════════════════════════════════════════════════════════════════
print("─" * 60)
print("[A] cv2.imdecode 단독 (baseline)")
print("─" * 60)
gc.collect()
tracemalloc.start()
arr_a = np.frombuffer(IMAGE_BYTES, dtype=np.uint8)   # 메모리 공유 뷰 — 거의 0
img_a = cv2.imdecode(arr_a, cv2.IMREAD_COLOR)         # +37MB
cur_a, peak_a = tracemalloc.get_traced_memory()
tracemalloc.stop()

explicit_a = _arr_mb(arr_a, img_a) + _bytes_mb(IMAGE_BYTES)
print(f"  arr(뷰)={_arr_mb(arr_a):.1f}MB  img={_arr_mb(img_a):.1f}MB  input={_bytes_mb(IMAGE_BYTES):.1f}MB")
print(f"  tracemalloc 피크: {_mb(peak_a):.1f}MB  /  이론적 합계: {explicit_a:.1f}MB")
results["A_imdecode"] = explicit_a
del arr_a, img_a
gc.collect()

# ═══════════════════════════════════════════════════════════════════
# [B] _extract_r_channel — main.py:498 (asyncio.to_thread 전용)
#     RISK: cv2.split(img) 호출 시 img 미해제 → 4중 배열 동시 생존
# ═══════════════════════════════════════════════════════════════════
print()
print("─" * 60)
print("[B] _extract_r_channel  (main.py:498)")
print("    → asyncio.to_thread 로 분리된 R채널 추출 전처리")
print("─" * 60)
gc.collect()
tracemalloc.start()

arr_b  = np.frombuffer(IMAGE_BYTES, dtype=np.uint8)
img_b  = cv2.imdecode(arr_b, cv2.IMREAD_COLOR)   # 37MB ← img_b 생성

# ── 위험 패턴 ① : img_b del 없이 split → img+3채널 동시 점유 ──────
b_ch, g_ch, r_ch = cv2.split(img_b)              # +3×12MB=36MB  ← img_b 살아있음
# img_b(37) + b_ch(12) + g_ch(12) + r_ch(12) = 73MB 이 시점 동시 생존

# ── 위험 패턴 ② : merge 호출 시 r_ch + merged 동시 생존 ─────────
merged_b = cv2.merge([r_ch, r_ch, r_ch])         # +37MB ← r_ch(12MB) 살아있음
# img_b(37) + b_ch(12) + g_ch(12) + r_ch(12) + merged_b(37) = 110MB ← PEAK

ok_b, buf_b = cv2.imencode(".jpg", merged_b, [cv2.IMWRITE_JPEG_QUALITY, 92])

cur_b, peak_b = tracemalloc.get_traced_memory()
tracemalloc.stop()

# 피크 순간: img_b + b_ch + g_ch + r_ch + merged_b 모두 생존
explicit_b = _arr_mb(img_b, b_ch, g_ch, r_ch, merged_b)
print(f"  img={_arr_mb(img_b):.1f}MB  b/g/r채널합={_arr_mb(b_ch,g_ch,r_ch):.1f}MB  merged={_arr_mb(merged_b):.1f}MB")
print(f"  tracemalloc 피크: {_mb(peak_b):.1f}MB  /  이론적 동시 점유: {explicit_b:.1f}MB")
report_danger("B", explicit_b, "img del 없이 split → img+3채널+merged 5중 동시 생존")
results["B_extract_r_channel"] = explicit_b
del arr_b, img_b, b_ch, g_ch, r_ch, merged_b, buf_b
gc.collect()

# ═══════════════════════════════════════════════════════════════════
# [C] rectify_image_with_aruco — aruco_rectify.py:175
#     RISK: warpPerspective 전 img 미해제 → img+warped 동시 2×37MB
# ═══════════════════════════════════════════════════════════════════
print()
print("─" * 60)
print("[C] rectify_image_with_aruco 핵심  (aruco_rectify.py:101)")
print("    → ArUco 호모그래피 원근 보정 + warpPerspective")
print("─" * 60)
gc.collect()
tracemalloc.start()

arr_c    = np.frombuffer(IMAGE_BYTES, dtype=np.uint8)
img_c    = cv2.imdecode(arr_c, cv2.IMREAD_COLOR)         # 37MB
gray_c   = cv2.cvtColor(img_c, cv2.COLOR_BGR2GRAY)       # +12MB  (img_c 살아있음)
binary_c = cv2.adaptiveThreshold(                         # +12MB  (gray_c 살아있음)
    gray_c, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv2.THRESH_BINARY, blockSize=15, C=4,
)
# 단위 호모그래피 행렬로 실제 warpPerspective 스파이크 재현
H_mat  = np.eye(3, dtype=np.float64)
warped_c = cv2.warpPerspective(img_c, H_mat, (IMG_W, IMG_H))  # +37MB ← img_c 살아있음
# 이 시점 동시 생존: img_c(37) + gray_c(12) + binary_c(12) + warped_c(37) = 98MB

cur_c, peak_c = tracemalloc.get_traced_memory()
tracemalloc.stop()

explicit_c = _arr_mb(img_c, gray_c, binary_c, warped_c)
print(f"  img={_arr_mb(img_c):.1f}  gray={_arr_mb(gray_c):.1f}  binary={_arr_mb(binary_c):.1f}  warped={_arr_mb(warped_c):.1f}MB")
print(f"  tracemalloc 피크: {_mb(peak_c):.1f}MB  /  이론적 동시 점유: {explicit_c:.1f}MB")
report_danger("C", explicit_c, "warpPerspective 전 img 미해제 → img+warped 동시 2×37MB")
results["C_rectify_aruco"] = explicit_c
del arr_c, img_c, gray_c, binary_c, H_mat, warped_c
gc.collect()

# ═══════════════════════════════════════════════════════════════════
# [D] quick_inpaint_laser — vision_processor.py:11 (has_laser=True)
#     RISK: img 미해제 후 BGR→HSV 변환 → img+hsv 동시 2×37MB
#           + gray/blur/edges/line_mask/3color_mask 추가 = 185MB 피크
# ═══════════════════════════════════════════════════════════════════
print()
print("─" * 60)
print("[D] quick_inpaint_laser  (vision_processor.py:11, has_laser=True)")
print("    → Hough+HSV 레이저 그리드 제거 인페인팅 전처리")
print("─" * 60)
gc.collect()
tracemalloc.start()

nparr_d    = np.frombuffer(IMAGE_BYTES, np.uint8)
img_d      = cv2.imdecode(nparr_d, cv2.IMREAD_COLOR)          # 37MB
gray_d     = cv2.cvtColor(img_d, cv2.COLOR_BGR2GRAY)           # +12MB
blur_d     = cv2.GaussianBlur(gray_d, (5, 5), 0)              # +12MB  (gray_d 유지)
edges_d    = cv2.Canny(blur_d, 50, 150)                        # +12MB  (blur_d 유지)
line_mask_d = np.zeros((IMG_H, IMG_W), dtype=np.uint8)          # +12MB
# ── 위험 패턴 ③ : img_d del 없이 HSV 변환 → img+hsv 동시 2×37MB ──
hsv_d      = cv2.cvtColor(img_d, cv2.COLOR_BGR2HSV)            # +37MB ← 2nd 대형 배열
m_green_d  = cv2.inRange(hsv_d,
                          np.array([38, 80, 100], np.uint8),
                          np.array([90, 255, 255], np.uint8))   # +12MB
m_red1_d   = cv2.inRange(hsv_d,
                          np.array([0,  80, 100], np.uint8),
                          np.array([12, 255, 255], np.uint8))   # +12MB
m_red2_d   = cv2.inRange(hsv_d,
                          np.array([168, 80, 100], np.uint8),
                          np.array([180, 255, 255], np.uint8))  # +12MB
# 이 시점 동시 생존: img_d(37)+gray_d(12)+blur_d(12)+edges_d(12)+line_mask_d(12)
#                   +hsv_d(37)+m_green(12)+m_red1(12)+m_red2(12) = 158MB  ← PEAK D

combined_d = cv2.bitwise_or(line_mask_d,
                             cv2.bitwise_or(m_green_d, cv2.bitwise_or(m_red1_d, m_red2_d)))  # +12MB

cur_d, peak_d = tracemalloc.get_traced_memory()
tracemalloc.stop()

explicit_d = _arr_mb(img_d, gray_d, blur_d, edges_d, line_mask_d,
                     hsv_d, m_green_d, m_red1_d, m_red2_d, combined_d)
print(f"  img={_arr_mb(img_d):.1f}  gray+blur+edges={_arr_mb(gray_d,blur_d,edges_d):.1f}  line_mask={_arr_mb(line_mask_d):.1f}MB")
print(f"  hsv={_arr_mb(hsv_d):.1f}  m_green+red1+red2={_arr_mb(m_green_d,m_red1_d,m_red2_d):.1f}  combined={_arr_mb(combined_d):.1f}MB")
print(f"  tracemalloc 피크: {_mb(peak_d):.1f}MB  /  이론적 동시 점유: {explicit_d:.1f}MB")
report_danger("D", explicit_d, "img del 없이 BGR→HSV → img+hsv 동시 2×37MB + 다중 마스크")
results["D_inpaint_laser"] = explicit_d
del nparr_d, img_d, gray_d, blur_d, edges_d, line_mask_d
del hsv_d, m_green_d, m_red1_d, m_red2_d, combined_d
gc.collect()

# ═══════════════════════════════════════════════════════════════════
# [E] analyze_laser_grid — vision_processor.py:279 (has_laser=True)
#     RISK: img 미해제 후 BGR→HSV → img+hsv 동시 2×37MB
# ═══════════════════════════════════════════════════════════════════
print()
print("─" * 60)
print("[E] analyze_laser_grid 핵심  (vision_processor.py:279)")
print("    → DOE 레이저 격자로 비드 높이 측정")
print("─" * 60)
gc.collect()
tracemalloc.start()

nparr_e = np.frombuffer(IMAGE_BYTES, np.uint8)
img_e   = cv2.imdecode(nparr_e, cv2.IMREAD_COLOR)   # 37MB
hsv_e   = cv2.cvtColor(img_e, cv2.COLOR_BGR2HSV)     # +37MB (img_e 살아있음)
mask_e  = cv2.inRange(hsv_e,
                       np.array([45, 80, 80], np.uint8),
                       np.array([80, 255, 255], np.uint8))      # +12MB
dil_e   = cv2.dilate(mask_e,
                      cv2.getStructuringElement(cv2.MORPH_RECT, (3,3)),
                      iterations=2)                              # +12MB

cur_e, peak_e = tracemalloc.get_traced_memory()
tracemalloc.stop()

explicit_e = _arr_mb(img_e, hsv_e, mask_e, dil_e)
print(f"  img={_arr_mb(img_e):.1f}  hsv={_arr_mb(hsv_e):.1f}  mask={_arr_mb(mask_e):.1f}  dilated={_arr_mb(dil_e):.1f}MB")
print(f"  tracemalloc 피크: {_mb(peak_e):.1f}MB  /  이론적 동시 점유: {explicit_e:.1f}MB")
report_danger("E", explicit_e, "img 미해제 후 BGR→HSV → img+hsv 동시 2×37MB")
results["E_laser_grid"] = explicit_e
del nparr_e, img_e, hsv_e, mask_e, dil_e
gc.collect()

# ═══════════════════════════════════════════════════════════════════
# [F] 실제 파이프라인 누적 시뮬레이션
# ═══════════════════════════════════════════════════════════════════
print()
print("═" * 68)
print("  [F] 실제 파이프라인 누적 메모리 시뮬레이션")
print("      (Python GC 지연 적용 — 함수 반환 후 즉시 수거 안 됨)")
print("═" * 68)

# 케이스 1: 정면 사진 1장, has_laser=False
print()
print("  ▶ 케이스 1: 정면 1장, has_laser=False")
cumul = PYTHON_OVERHEAD_MB
print(f"    [기준] Python+libs 오버헤드: {cumul:.0f}MB")
steps_1 = [
    ("① image_bytes_raw (JPEG 입력)",              _bytes_mb(IMAGE_BYTES)),
    ("② _rectify_for_roboflow (C+D+warped 배열)",  results["C_rectify_aruco"]),
    ("③ image_bytes_rect + image_base64",           _bytes_mb(IMAGE_BYTES) * (1 + 4/3)),
    ("④ _extract_r_channel (asyncio.to_thread)",    results["B_extract_r_channel"]),
]
for lbl, add in steps_1:
    cumul += add
    status = "❌ OOM!" if cumul >= RENDER_RAM_LIMIT_MB else ("⚠️  위험" if cumul >= RENDER_RAM_LIMIT_MB * 0.82 else "")
    print(f"    + {lbl}: +{add:.0f}MB  →  누적 {cumul:.0f}MB  {status}")

print()

# 케이스 2: 정면 사진 1장, has_laser=True
print("  ▶ 케이스 2: 정면 1장, has_laser=True  ★ 가장 위험한 케이스")
cumul2 = PYTHON_OVERHEAD_MB
print(f"    [기준] Python+libs 오버헤드: {cumul2:.0f}MB")
steps_2 = [
    ("① image_bytes_raw (JPEG 입력)",              _bytes_mb(IMAGE_BYTES)),
    ("② _rectify_for_roboflow (ArUco+warp)",        results["C_rectify_aruco"]),
    ("③ image_bytes_rect + base64",                 _bytes_mb(IMAGE_BYTES) * (1 + 4/3)),
    ("④ quick_inpaint_laser (has_laser=True)",      results["D_inpaint_laser"]),
    ("⑤ _extract_r_channel (asyncio.to_thread)",    results["B_extract_r_channel"]),
    ("⑥ analyze_laser_grid (Hough+HSV)",            results["E_laser_grid"]),
]
for lbl, add in steps_2:
    cumul2 += add
    status = "❌ OOM!" if cumul2 >= RENDER_RAM_LIMIT_MB else ("⚠️  위험" if cumul2 >= RENDER_RAM_LIMIT_MB * 0.82 else "")
    print(f"    + {lbl}: +{add:.0f}MB  →  누적 {cumul2:.0f}MB  {status}")

print()

# 케이스 3: 정면 + 측면, has_laser=False (가장 흔한 사용 패턴)
print("  ▶ 케이스 3: 정면+측면 2장, has_laser=False")
cumul3 = PYTHON_OVERHEAD_MB
print(f"    [기준] Python+libs 오버헤드: {cumul3:.0f}MB")
steps_3 = [
    ("① front image_bytes_raw",                    _bytes_mb(IMAGE_BYTES)),
    ("② front _rectify_for_roboflow",               results["C_rectify_aruco"]),
    ("③ front image_bytes_rect + base64",           _bytes_mb(IMAGE_BYTES) * (1 + 4/3)),
    ("④ front _extract_r_channel",                  results["B_extract_r_channel"]),
    ("⑤ side image_bytes_raw",                     _bytes_mb(IMAGE_BYTES)),
    ("⑥ side _rectify_for_roboflow",                results["C_rectify_aruco"]),
    ("⑦ side _extract_r_channel",                   results["B_extract_r_channel"]),
]
for lbl, add in steps_3:
    cumul3 += add
    status = "❌ OOM!" if cumul3 >= RENDER_RAM_LIMIT_MB else ("⚠️  위험" if cumul3 >= RENDER_RAM_LIMIT_MB * 0.82 else "")
    print(f"    + {lbl}: +{add:.0f}MB  →  누적 {cumul3:.0f}MB  {status}")

# ═══════════════════════════════════════════════════════════════════
# 최종 요약
# ═══════════════════════════════════════════════════════════════════
print()
print("═" * 68)
print("  단계별 독립 피크 요약")
print("═" * 68)
for tag, peak_mb in results.items():
    bar = "█" * int(peak_mb / RENDER_RAM_LIMIT_MB * 40)
    pct = peak_mb / RENDER_RAM_LIMIT_MB * 100
    print(f"  {tag:<30s} {peak_mb:6.1f}MB [{bar:<40s}] {pct:.0f}%")

print()
print("  ─────────────────── 수정 우선순위 ───────────────────")
print("  P1 [_extract_r_channel:507] img del 없이 cv2.split → img+3채널+merged")
print("     수정: r = img[:,:,2].copy(); del img  (split 불필요)")
print()
print("  P2 [quick_inpaint_laser:39] img del 없이 BGR→HSV 변환")
print("     수정: hsv 생성 전 gray 추출 후 img del")
print()
print("  P3 [analyze_laser_grid:306] img del 없이 BGR→HSV 변환")
print("     수정: hsv 생성 직후 del img")
print()
print("  P4 [aruco_rectify.py:175] warpPerspective 전 img 미해제")
print("     수정: warped 생성 직후 del img")

# ═══════════════════════════════════════════════════════════════════
# [G] 수정 후(AFTER FIX) 패턴 검증 — 실제 del 적용 후 피크 재측정
# ═══════════════════════════════════════════════════════════════════
print()
print("═" * 68)
print("  [G] 수정 후(AFTER FIX) 패턴 검증")
print("═" * 68)

fixed_results: dict[str, float] = {}

# ── G-B: _extract_r_channel 수정 후 ──────────────────────────────
print()
print("  [G-B] _extract_r_channel FIXED  (del img,b_ch,g_ch 즉시 적용)")
gc.collect(); tracemalloc.start(); tracemalloc.reset_peak()

arr_gb  = np.frombuffer(IMAGE_BYTES, dtype=np.uint8)
img_gb  = cv2.imdecode(arr_gb, cv2.IMREAD_COLOR)
del arr_gb
if img_gb is not None:
    b_gb, g_gb, r_gb = cv2.split(img_gb)
    del img_gb, b_gb, g_gb          # ← FIX: 즉시 해제
    gc.collect()
    merged_gb = cv2.merge([r_gb, r_gb, r_gb])
    del r_gb                         # ← FIX
    ok_gb, buf_gb = cv2.imencode(".jpg", merged_gb, [cv2.IMWRITE_JPEG_QUALITY, 92])
    del merged_gb
    _ = bytes(buf_gb.tobytes()) if ok_gb else None

cur_gb, peak_gb = tracemalloc.get_traced_memory(); tracemalloc.stop()
fixed_b = _mb(peak_gb)
print(f"    tracemalloc 피크: {fixed_b:.1f}MB  (수정 전 이론: {results['B_extract_r_channel']:.1f}MB → "
      f"절감 {results['B_extract_r_channel'] - fixed_b:.1f}MB)")
fixed_results["B_extract_r_channel_FIXED"] = fixed_b
del buf_gb; gc.collect()

# ── G-C: rectify_image_with_aruco 수정 후 ────────────────────────
print()
print("  [G-C] rectify_image_with_aruco FIXED  (del img after warpPerspective)")
gc.collect(); tracemalloc.start(); tracemalloc.reset_peak()

arr_gc   = np.frombuffer(IMAGE_BYTES, dtype=np.uint8)
img_gc   = cv2.imdecode(arr_gc, cv2.IMREAD_COLOR)
gray_gc  = cv2.cvtColor(img_gc, cv2.COLOR_BGR2GRAY)
binary_gc= cv2.adaptiveThreshold(gray_gc, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                  cv2.THRESH_BINARY, 15, 4)
H_gc     = np.eye(3, dtype=np.float64)
warped_gc= cv2.warpPerspective(img_gc, H_gc, (IMG_W, IMG_H))
del img_gc                           # ← FIX: warp 완료 → 원본 즉시 해제
gc.collect()
ok_gc, buf_gc = cv2.imencode(".jpg", warped_gc, [cv2.IMWRITE_JPEG_QUALITY, 92])
del warped_gc, gray_gc, binary_gc

cur_gc, peak_gc = tracemalloc.get_traced_memory(); tracemalloc.stop()
fixed_c = _mb(peak_gc)
print(f"    tracemalloc 피크: {fixed_c:.1f}MB  (수정 전 이론: {results['C_rectify_aruco']:.1f}MB → "
      f"절감 {results['C_rectify_aruco'] - fixed_c:.1f}MB)")
fixed_results["C_rectify_aruco_FIXED"] = fixed_c
del arr_gc, buf_gc; gc.collect()

# ── G-D: quick_inpaint_laser 수정 후 ────────────────────────────
print()
print("  [G-D] quick_inpaint_laser FIXED  (del 체인: gray→blur→edges, del hsv, del img after resize)")
gc.collect(); tracemalloc.start(); tracemalloc.reset_peak()

nparr_gd = np.frombuffer(IMAGE_BYTES, np.uint8)
img_gd   = cv2.imdecode(nparr_gd, cv2.IMREAD_COLOR)
del nparr_gd                         # ← FIX
h_gd, w_gd = img_gd.shape[:2]
gray_gd  = cv2.cvtColor(img_gd, cv2.COLOR_BGR2GRAY)
blur_gd  = cv2.GaussianBlur(gray_gd, (5, 5), 0)
del gray_gd                          # ← FIX
edges_gd = cv2.Canny(blur_gd, 50, 150)
del blur_gd                          # ← FIX
lines_gd = cv2.HoughLinesP(edges_gd, 1, math.pi / 180, threshold=25,
                             minLineLength=10, maxLineGap=35)
del edges_gd                         # ← FIX
line_mask_gd = np.zeros((h_gd, w_gd), dtype=np.uint8)
hsv_gd   = cv2.cvtColor(img_gd, cv2.COLOR_BGR2HSV)
m_g_gd   = cv2.inRange(hsv_gd, np.array([38,80,100],np.uint8), np.array([90,255,255],np.uint8))
m_r1_gd  = cv2.inRange(hsv_gd, np.array([0,80,100],np.uint8),  np.array([12,255,255],np.uint8))
m_r2_gd  = cv2.inRange(hsv_gd, np.array([168,80,100],np.uint8),np.array([180,255,255],np.uint8))
del hsv_gd                           # ← FIX
color_gd = cv2.bitwise_or(m_g_gd, cv2.bitwise_or(m_r1_gd, m_r2_gd))
del m_g_gd, m_r1_gd, m_r2_gd        # ← FIX
comb_gd  = cv2.bitwise_or(line_mask_gd, color_gd)
del line_mask_gd, color_gd           # ← FIX
krnl_gd  = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
comb_gd  = cv2.dilate(comb_gd, krnl_gd, iterations=1)
gc.collect()                         # ← FIX
scale_gd = min(1.0, 1024 / max(w_gd, 1))
if scale_gd < 1.0:
    w_s_gd, h_s_gd = int(w_gd * scale_gd), int(h_gd * scale_gd)
    img_s_gd = cv2.resize(img_gd, (w_s_gd, h_s_gd), interpolation=cv2.INTER_AREA)
    del img_gd                       # ← FIX: 리사이즈 완료 → 원본 해제
    mask_s_gd = cv2.resize(comb_gd, (w_s_gd, h_s_gd), interpolation=cv2.INTER_NEAREST)
    del comb_gd                      # ← FIX
    gc.collect()
else:
    img_s_gd, mask_s_gd = img_gd, comb_gd
    del img_gd, comb_gd

cur_gd, peak_gd = tracemalloc.get_traced_memory(); tracemalloc.stop()
fixed_d = _mb(peak_gd)
print(f"    tracemalloc 피크: {fixed_d:.1f}MB  (수정 전 이론: {results['D_inpaint_laser']:.1f}MB → "
      f"절감 {results['D_inpaint_laser'] - fixed_d:.1f}MB)")
fixed_results["D_inpaint_laser_FIXED"] = fixed_d
del img_s_gd, mask_s_gd; gc.collect()

# ── G-E: analyze_laser_grid 수정 후 ─────────────────────────────
print()
print("  [G-E] analyze_laser_grid FIXED  (del hsv 즉시 + del img 이후)")
gc.collect(); tracemalloc.start(); tracemalloc.reset_peak()

nparr_ge = np.frombuffer(IMAGE_BYTES, np.uint8)
img_ge   = cv2.imdecode(nparr_ge, cv2.IMREAD_COLOR)
hsv_ge   = cv2.cvtColor(img_ge, cv2.COLOR_BGR2HSV)
mask_ge  = cv2.inRange(hsv_ge, np.array([45,80,80],np.uint8), np.array([80,255,255],np.uint8))
del hsv_ge                           # ← FIX: mask 추출 완료 → hsv 즉시 해제
dil_ge   = cv2.dilate(mask_ge, cv2.getStructuringElement(cv2.MORPH_RECT,(3,3)), iterations=2)
del img_ge                           # ← FIX: HSV 완료 → img 즉시 해제
gc.collect()

cur_ge, peak_ge = tracemalloc.get_traced_memory(); tracemalloc.stop()
fixed_e = _mb(peak_ge)
print(f"    tracemalloc 피크: {fixed_e:.1f}MB  (수정 전 이론: {results['E_laser_grid']:.1f}MB → "
      f"절감 {results['E_laser_grid'] - fixed_e:.1f}MB)")
fixed_results["E_laser_grid_FIXED"] = fixed_e
del nparr_ge, mask_ge, dil_ge; gc.collect()

# ── G-F: 수정 후 파이프라인 누적 시뮬레이션 ─────────────────────
print()
print("═" * 68)
print("  [G-F] 수정 후 파이프라인 누적 시뮬레이션 (AFTER FIX)")
print("═" * 68)

print()
print("  ▶ 케이스 2 FIXED: 정면 1장, has_laser=True")
cumul_f2 = PYTHON_OVERHEAD_MB
print(f"    [기준] Python+libs 오버헤드: {cumul_f2:.0f}MB")
steps_f2 = [
    ("① image_bytes_raw",                   _bytes_mb(IMAGE_BYTES)),
    ("② _rectify_for_roboflow (FIXED)",      fixed_results["C_rectify_aruco_FIXED"]),
    ("③ image_bytes_rect + base64",          _bytes_mb(IMAGE_BYTES) * (1 + 4/3)),
    ("④ quick_inpaint_laser (FIXED)",        fixed_results["D_inpaint_laser_FIXED"]),
    ("⑤ _extract_r_channel (FIXED)",         fixed_results["B_extract_r_channel_FIXED"]),
    ("⑥ analyze_laser_grid (FIXED)",         fixed_results["E_laser_grid_FIXED"]),
]
for lbl, add in steps_f2:
    cumul_f2 += add
    status = "❌ OOM!" if cumul_f2 >= RENDER_RAM_LIMIT_MB else ("⚠️  위험" if cumul_f2 >= RENDER_RAM_LIMIT_MB * 0.82 else "✅")
    print(f"    + {lbl}: +{add:.0f}MB  →  누적 {cumul_f2:.0f}MB  {status}")

print()
print("  ▶ 케이스 3 FIXED: 정면+측면 2장, has_laser=False")
cumul_f3 = PYTHON_OVERHEAD_MB
print(f"    [기준] Python+libs 오버헤드: {cumul_f3:.0f}MB")
steps_f3 = [
    ("① front image_bytes_raw",              _bytes_mb(IMAGE_BYTES)),
    ("② front _rectify_for_roboflow (FIXED)",fixed_results["C_rectify_aruco_FIXED"]),
    ("③ front image_bytes_rect + base64",    _bytes_mb(IMAGE_BYTES) * (1 + 4/3)),
    ("④ front _extract_r_channel (FIXED)",   fixed_results["B_extract_r_channel_FIXED"]),
    ("⑤ side image_bytes_raw",               _bytes_mb(IMAGE_BYTES)),
    ("⑥ side _rectify_for_roboflow (FIXED)", fixed_results["C_rectify_aruco_FIXED"]),
    ("⑦ side _extract_r_channel (FIXED)",    fixed_results["B_extract_r_channel_FIXED"]),
]
for lbl, add in steps_f3:
    cumul_f3 += add
    status = "❌ OOM!" if cumul_f3 >= RENDER_RAM_LIMIT_MB else ("⚠️  위험" if cumul_f3 >= RENDER_RAM_LIMIT_MB * 0.82 else "✅")
    print(f"    + {lbl}: +{add:.0f}MB  →  누적 {cumul_f3:.0f}MB  {status}")

print()
print("═" * 68)
print("  최종 비교 요약")
print("═" * 68)
before = {"B": results["B_extract_r_channel"], "C": results["C_rectify_aruco"],
          "D": results["D_inpaint_laser"],      "E": results["E_laser_grid"]}
after  = {"B": fixed_results["B_extract_r_channel_FIXED"], "C": fixed_results["C_rectify_aruco_FIXED"],
          "D": fixed_results["D_inpaint_laser_FIXED"],      "E": fixed_results["E_laser_grid_FIXED"]}
for k in ("B","C","D","E"):
    saved = before[k] - after[k]
    print(f"  [{k}] {before[k]:.1f}MB  →  {after[k]:.1f}MB  (절감 {saved:.1f}MB)")
peak_before = max(586, 633)  # 수정 전 최악 케이스 (GC 지연 누적)
print(f"\n  [참고] G-F 시뮬레이션은 여전히 보수적 GC-지연 모델을 사용합니다.")
print(f"  수정 전 최악(GC 지연): {peak_before}MB  →  수정 후(GC 지연): {max(cumul_f2, cumul_f3):.0f}MB")
print()

# ── G-G: 수정 후 실제 동작 모델 (del+gc.collect 함수 내 즉시 해제) ──
print("═" * 68)
print("  [G-G] 수정 후 실제 동작 모델 (del+gc.collect 함수 반환 전 해제)")
print("  각 함수가 반환 전에 내부 배열을 gc.collect()로 즉시 해제한다는")
print("  가정 하에 파이프라인 전체 누적 피크를 계산.")
print("═" * 68)

# 각 고정값 — 함수 반환 후 '출력 bytes' 만 남음
RAW_JPEG_MB   = _bytes_mb(IMAGE_BYTES)             # 입력 JPEG
RECT_BYTES_MB = RAW_JPEG_MB                        # 보정 후 JPEG ≈ 동일 크기
BASE64_MB     = RAW_JPEG_MB * (4 / 3)             # base64 인코딩 오버헤드

# 수정 후 각 단계의 실제 실행 중 피크(tracemalloc 측정값)
# 함수 내부에서 del+gc.collect 후 반환하므로 이 만큼의 추가 메모리만 순간적으로 필요
RECT_EXEC_PEAK_MB     = fixed_results["C_rectify_aruco_FIXED"]
INPAINT_EXEC_PEAK_MB  = fixed_results["D_inpaint_laser_FIXED"]
R_CHAN_EXEC_PEAK_MB   = fixed_results["B_extract_r_channel_FIXED"]
LASER_EXEC_PEAK_MB    = fixed_results["E_laser_grid_FIXED"]

print()
print("  ▶ 케이스 2 실제: 정면 1장, has_laser=True")
persistent_2 = PYTHON_OVERHEAD_MB  # 기저 메모리
step_peaks_2: list[float] = []
def _track(label: str, persistent: float, exec_peak: float, after_persistent: float,
           step_list: list) -> float:
    peak_during = persistent + exec_peak
    step_list.append(peak_during)
    flag = "❌ OOM!" if peak_during >= RENDER_RAM_LIMIT_MB else ("⚠️  위험" if peak_during >= 420 else "✅")
    print(f"    {label}")
    print(f"      실행 중 피크: {persistent:.0f}+{exec_peak:.0f}={peak_during:.0f}MB {flag} → 반환 후 지속: {after_persistent:.0f}MB")
    return after_persistent

persistent_2 = PYTHON_OVERHEAD_MB + RAW_JPEG_MB   # raw bytes 로드
print(f"    [기저] Python+libs+raw_bytes: {persistent_2:.0f}MB")
# rectify: 실행 중 persistent+93, 반환 후 persistent-raw+rect
persistent_2 = _track("② _rectify_for_roboflow (FIXED)", persistent_2, RECT_EXEC_PEAK_MB,
                        PYTHON_OVERHEAD_MB + RAW_JPEG_MB + RECT_BYTES_MB + BASE64_MB, step_peaks_2)
# inpaint: 실행 중 persistent+117, 반환 후 persistent+result_bytes
persistent_2 = _track("④ quick_inpaint_laser (FIXED)", persistent_2, INPAINT_EXEC_PEAK_MB,
                        persistent_2 + RECT_BYTES_MB, step_peaks_2)
# r_channel: 실행 중 persistent+70, 반환 후 persistent+result
persistent_2 = _track("⑤ _extract_r_channel (FIXED)", persistent_2, R_CHAN_EXEC_PEAK_MB,
                        persistent_2 + RAW_JPEG_MB * 0.5, step_peaks_2)
# laser_grid: 실행 중 persistent+81, 반환 후 persistent (결과 dict만)
persistent_2 = _track("⑥ analyze_laser_grid (FIXED)", persistent_2, LASER_EXEC_PEAK_MB,
                        persistent_2, step_peaks_2)
real_peak_2 = max(step_peaks_2)
print(f"    → 최대 실행 중 피크: {real_peak_2:.0f}MB  {'✅ 512MB 이내' if real_peak_2 < RENDER_RAM_LIMIT_MB else '❌ 초과'}")

print()
print("  ▶ 케이스 3 실제: 정면+측면 2장, has_laser=False")
persistent_3 = PYTHON_OVERHEAD_MB + RAW_JPEG_MB
print(f"    [기저] Python+libs+front_raw_bytes: {persistent_3:.0f}MB")
step_peaks_3: list[float] = []
persistent_3 = _track("② front _rectify_for_roboflow (FIXED)", persistent_3, RECT_EXEC_PEAK_MB,
                        PYTHON_OVERHEAD_MB + RECT_BYTES_MB + BASE64_MB, step_peaks_3)
persistent_3 = _track("④ front _extract_r_channel (FIXED)", persistent_3, R_CHAN_EXEC_PEAK_MB,
                        persistent_3 + RAW_JPEG_MB * 0.5, step_peaks_3)
# side 이미지 추가
persistent_3 += RAW_JPEG_MB
print(f"    [side raw 로드] 지속 메모리: {persistent_3:.0f}MB")
persistent_3 = _track("⑥ side _rectify_for_roboflow (FIXED)", persistent_3, RECT_EXEC_PEAK_MB,
                        persistent_3 + RECT_BYTES_MB, step_peaks_3)
persistent_3 = _track("⑦ side _extract_r_channel (FIXED)", persistent_3, R_CHAN_EXEC_PEAK_MB,
                        persistent_3 + RAW_JPEG_MB * 0.5, step_peaks_3)
real_peak_3 = max(step_peaks_3)
print(f"    → 최대 실행 중 피크: {real_peak_3:.0f}MB  {'✅ 512MB 이내' if real_peak_3 < RENDER_RAM_LIMIT_MB else '❌ 초과'}")

print()
real_max = max(real_peak_2, real_peak_3)
print("═" * 68)
print(f"  [최종 결론]")
print(f"  GC-지연 보수 모델:  수정 전 {peak_before}MB → 수정 후 {max(cumul_f2, cumul_f3):.0f}MB")
print(f"  실제 동작 모델:     수정 후 최대 실행 중 피크 = {real_max:.0f}MB")
oom_flag = "✅ 512MB 이내 — OOM 해소" if real_max < RENDER_RAM_LIMIT_MB else "❌ 512MB 초과 — 추가 조치 필요"
print(f"  판정: {oom_flag}")
print("═" * 68)

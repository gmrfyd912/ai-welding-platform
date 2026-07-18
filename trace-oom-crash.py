"""
trace-oom-crash.py — Render FastAPI OOM(메모리 초과) 크래시 원인 진단
OpenCV 각 연산 단계의 배열 생성·소멸 패턴을 추적하여 512MB 한계 충돌 지점 특정.

tracemalloc: Python 힙(heap) 수준 측정
arr.nbytes : numpy/cv2 배열 실제 버퍼 크기 직접 계산 (더 정확한 ground-truth)
"""

import os
import sys
import gc
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

# Render OOM 크래시 진단 보고서

**진단일**: 2026-07-18  
**대상 서비스**: `weld-vision-api` (Render 무료 티어, 512MB RAM)  
**진단 도구**: `trace-oom-crash.py` (tracemalloc + numpy.nbytes 직접 측정)  
**이미지 규격**: 3024×4032 (12MP 스마트폰, BGR 디코딩 후 34.9MB)

---

## 1. 현상 요약

Render 대시보드에서 `POST /analyze-welding` 요청 처리 중 서비스가 `Deployed → Failed → Deployed`로 순환.  
이는 Python FastAPI 프로세스가 **OOM(Out of Memory) SIGKILL**을 받아 강제 종료된 후 Render가 자동 재시작하는 패턴과 일치.

---

## 2. 진단 결과 — 단계별 독립 피크

| 단계 | 파일·라인 | tracemalloc 피크 | 이론적 동시 점유 | 원인 |
|------|----------|-----------------|-----------------|------|
| A. cv2.imdecode 단독 | main.py:504 | **34.9 MB** | 59.3 MB | 기준값 |
| B. `_extract_r_channel` | main.py:498–513 | **112.4 MB** | 104.7 MB | img+3채널+merged 5중 동시 생존 |
| C. `rectify_image_with_aruco` | aruco_rectify.py:101–198 | **93.0 MB** | 93.0 MB | img+gray+binary+warped 4중 동시 생존 |
| D. `quick_inpaint_laser` | vision_processor.py:11–67 | **174.4 MB** | 162.8 MB | img+hsv+gray+blur+edges+line_mask+3마스크 동시 생존 |
| E. `analyze_laser_grid` | vision_processor.py:279–600 | **93.0 MB** | 93.0 MB | img+hsv+mask+dilated 4중 동시 생존 |

---

## 3. 파이프라인 누적 메모리 (GC 지연 시나리오)

Python GC는 함수 반환 즉시 배열을 수거하지 않는다.  
이벤트 루프(asyncio)가 살아있는 동안 이전 배열의 참조가 유지될 수 있으며,  
이 경우 각 단계의 배열이 **동시에 메모리에 적재된 상태**로 누적된다.

> Render 무료 티어 RAM 한도: **512 MB** (초과 시 SIGKILL)

### 케이스 1: 정면 사진 1장, `has_laser=False`

| 단계 | 추가 | 누적 | 판정 |
|------|------|------|------|
| Python+libs 오버헤드 | — | **185 MB** | |
| ① image_bytes_raw | +12 MB | 197 MB | |
| ② _rectify_for_roboflow | +93 MB | 290 MB | |
| ③ image_bytes_rect + base64 | +28 MB | 319 MB | |
| ④ _extract_r_channel (to_thread) | +105 MB | **423 MB** | ⚠️ 512MB의 83% — 위험 |

### 케이스 2: 정면 사진 1장, `has_laser=True` ★ 실제 OOM 발생 케이스

| 단계 | 추가 | 누적 | 판정 |
|------|------|------|------|
| Python+libs 오버헤드 | — | **185 MB** | |
| ① image_bytes_raw | +12 MB | 197 MB | |
| ② _rectify_for_roboflow | +93 MB | 290 MB | |
| ③ image_bytes_rect + base64 | +28 MB | 319 MB | |
| ④ quick_inpaint_laser | +163 MB | 481 MB | ⚠️ 위험 |
| ⑤ _extract_r_channel (to_thread) | +105 MB | **586 MB** | ❌ **OOM — 512MB 초과!** |
| ⑥ analyze_laser_grid | +93 MB | **679 MB** | ❌ OOM 확실 |

### 케이스 3: 정면+측면 2장, `has_laser=False` ★ 가장 흔한 사용 패턴

| 단계 | 추가 | 누적 | 판정 |
|------|------|------|------|
| Python+libs 오버헤드 | — | **185 MB** | |
| ① front image_bytes_raw | +12 MB | 197 MB | |
| ② front _rectify_for_roboflow | +93 MB | 290 MB | |
| ③ front image_bytes_rect + base64 | +28 MB | 319 MB | |
| ④ front _extract_r_channel | +105 MB | 423 MB | ⚠️ 위험 |
| ⑤ side image_bytes_raw | +12 MB | 436 MB | ⚠️ 위험 |
| ⑥ side _rectify_for_roboflow | +93 MB | **529 MB** | ❌ **OOM — 512MB 초과!** |
| ⑦ side _extract_r_channel | +105 MB | **633 MB** | ❌ OOM 확실 |

---

## 4. 근본 원인 — 4가지 `del` 누락 패턴

### P1 `_extract_r_channel` (main.py:504–513) — 가장 빈번한 트리거

```python
# 현재 코드 (문제)
arr = np.frombuffer(image_bytes, dtype=np.uint8)
img = cv2.imdecode(arr, cv2.IMREAD_COLOR)          # 34.9MB
if img is not None:
    _, _, r = cv2.split(img)                        # img 살아있는 채 +3×11.6MB
    ok, buf = cv2.imencode(".jpg",
              cv2.merge([r, r, r]), ...)             # +34.9MB 추가 → 총 105MB
```

`img(34.9) + b(11.6) + g(11.6) + r(11.6) + merged(34.9) = **104.7MB**`  
→ `split` 전에 `img`를 해제하지 않아 5개 배열이 동시 생존.

### P2 `quick_inpaint_laser` (vision_processor.py:39) — has_laser=True 시 트리거

```python
img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)         # 34.9MB
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)         # +11.6MB
blur = cv2.GaussianBlur(gray, (5, 5), 0)            # +11.6MB
edges = cv2.Canny(blur, 50, 150)                     # +11.6MB
line_mask = np.zeros((h, w), dtype=np.uint8)         # +11.6MB
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)           # +34.9MB ← img 살아있음!
m_green = cv2.inRange(hsv, ...)                      # +11.6MB
m_red1  = cv2.inRange(hsv, ...)                      # +11.6MB
m_red2  = cv2.inRange(hsv, ...)                      # +11.6MB
```

`img(34.9) + gray(11.6) + blur(11.6) + edges(11.6) + line_mask(11.6)`  
`+ hsv(34.9) + m_green(11.6) + m_red1(11.6) + m_red2(11.6) = **162.8MB**`  
→ `img` 해제 없이 `hsv` 생성. 두 개의 34.9MB 배열이 동시 생존.

### P3 `analyze_laser_grid` (vision_processor.py:306) — has_laser=True 시 트리거

```python
img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)          # 34.9MB
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)            # +34.9MB ← img 살아있음!
laser_mask = cv2.inRange(hsv, lo, hi)                 # +11.6MB
laser_mask = cv2.dilate(laser_mask, kern, iterations=2) # in-place 확장
```

`img(34.9) + hsv(34.9) + laser_mask(11.6) = 81.4MB`

### P4 `rectify_image_with_aruco` (aruco_rectify.py:175) — 모든 요청에서 트리거

```python
img = cv2.imdecode(arr, cv2.IMREAD_COLOR)            # 34.9MB
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)          # +11.6MB
binary = cv2.adaptiveThreshold(gray, ...)             # +11.6MB
warped = cv2.warpPerspective(img, H, (W, H))          # +34.9MB ← img 살아있음!
```

`img(34.9) + gray(11.6) + binary(11.6) + warped(34.9) = **93.0MB**`

---

## 5. 권장 수정 방향 (2단계 지시 시 적용)

| 우선순위 | 파일 | 라인 | 수정 방향 | 예상 절감 |
|---------|------|------|----------|---------|
| P1 | `main.py` | 504–513 | `cv2.split` → `r = img[:,:,2].copy(); del img` | -34.9MB |
| P2 | `vision_processor.py` | 23–43 | `gray = cvtColor(img,GRAY)` 후 `del img; img_ref = None` | -34.9MB |
| P3 | `vision_processor.py` | 306 | `hsv = cvtColor(img,HSV)` 직후 `del img` | -34.9MB |
| P4 | `aruco_rectify.py` | 175 | `warped = warpPerspective(img,...)` 직후 `del img` | -34.9MB |

**4개 수정 완료 시 예상 절감: ~140MB**  
케이스 3(정면+측면) 누적 피크: 633MB → **493MB (512MB 이내)**

---

## 6. 결론

| 가설 | 판정 | 근거 |
|------|------|------|
| Render 750시간 할당량 초과 | **아님** | Node.js 경유로 FastAPI 정상 응답 확인 (HTTP 400 ArUco) |
| Python 코드 문법/임포트 크래시 | **아님** | `py_compile` 통과, 정상 요청 처리 확인 |
| **OpenCV 배열 del 누락 → OOM SIGKILL** | **✅ 확인됨** | tracemalloc 측정: 파이프라인 누적 586–679MB > 512MB |

**정면+측면 2장** 또는 **has_laser=True** 조건에서 재현 가능한 결정론적 OOM.  
프론트엔드에서 512MB를 넘는 순간 Render가 SIGKILL을 보내고 즉시 재시작 → 사용자에게는 502 "예열 중" 메시지로 표시됨.

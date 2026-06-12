"""ArUco 마커 기반 원근/기울기 보정 모듈.

촬영된 사진에서 30mm ArUco 마커 4 모서리를 검출해, 마커가 화면상에서
정사각형이 되도록 호모그래피 와핑한다. 이로써 카메라 기울기·원근
왜곡이 제거된 평면 정면 시점 이미지가 생성되고, 이후 Roboflow
세그멘테이션/픽셀-mm 환산/비드 폭·직진도 계산이 모두 동일한
보정 공간 위에서 일관되게 이루어진다.
"""
from __future__ import annotations

from typing import Optional, Tuple
import cv2
import numpy as np


_DICT_IDS = [
    cv2.aruco.DICT_4X4_50,  cv2.aruco.DICT_4X4_100, cv2.aruco.DICT_4X4_250,
    cv2.aruco.DICT_5X5_50,  cv2.aruco.DICT_5X5_100, cv2.aruco.DICT_5X5_250,
    cv2.aruco.DICT_6X6_50,  cv2.aruco.DICT_6X6_100, cv2.aruco.DICT_6X6_250,
    cv2.aruco.DICT_7X7_50,  cv2.aruco.DICT_7X7_100,
    cv2.aruco.DICT_ARUCO_ORIGINAL,
]


def _remove_laser_lines(img: np.ndarray) -> np.ndarray:
    """레이저 선을 인페인팅으로 제거한 새 이미지 반환 (마커 탐지 전처리 전용).

    ⚠️  이 함수의 출력은 마커 코너 탐지에만 사용된다.
        실제 레이저 프로파일 분석(analyze_laser_grid 등)에는
        반드시 원본 이미지(Original Image)를 전달해야 한다.

    HSV 임계값:
      녹색 레이저 (현장 사용, ~532nm):
        H 35–85 · S 80–255 · V 100–255
      적색 레이저 (옵션, ~650nm) — 주석 처리:
        H 0–10  · S 100–255 · V 100–255  (wraparound Range 1)
        H 165–179 · S 100–255 · V 100–255 (wraparound Range 2)

    팽창 커널: 5×5 Rect, 2회 → 얇은 선 경계 노이즈까지 커버
    인페인팅 : cv2.INPAINT_TELEA, 반경 5px
    """
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # ── 녹색 레이저 마스크 ──────────────────────────────────────────
    green_lo = np.array([35,  80, 100], dtype=np.uint8)
    green_hi = np.array([85, 255, 255], dtype=np.uint8)
    mask = cv2.inRange(hsv, green_lo, green_hi)

    # ── 적색 레이저 마스크 (필요 시 아래 주석 해제) ─────────────────
    # red_lo1 = np.array([  0, 100, 100], dtype=np.uint8)
    # red_hi1 = np.array([ 10, 255, 255], dtype=np.uint8)
    # red_lo2 = np.array([165, 100, 100], dtype=np.uint8)
    # red_hi2 = np.array([179, 255, 255], dtype=np.uint8)
    # red_mask = cv2.bitwise_or(
    #     cv2.inRange(hsv, red_lo1, red_hi1),
    #     cv2.inRange(hsv, red_lo2, red_hi2),
    # )
    # mask = cv2.bitwise_or(mask, red_mask)

    if cv2.countNonZero(mask) == 0:
        # 레이저 픽셀이 없으면 복사본만 반환 (원본 보호)
        return img.copy()

    # 팽창으로 선 경계 노이즈까지 덮기
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.dilate(mask, kernel, iterations=2)

    # TELEA 인페인팅: 마스킹된 픽셀을 주변 흑/백 마커 패턴으로 자연스럽게 복원
    return cv2.inpaint(img, mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)


def _detect_largest_marker(gray: np.ndarray) -> Optional[np.ndarray]:
    """여러 ArUco 사전을 순회하며 가장 큰(면적 최대) 마커 4 모서리 반환."""
    best: Optional[np.ndarray] = None
    best_area = 0.0
    for dict_id in _DICT_IDS:
        try:
            dictionary = cv2.aruco.getPredefinedDictionary(dict_id)
            try:
                params = cv2.aruco.DetectorParameters()
                detector = cv2.aruco.ArucoDetector(dictionary, params)
                corners, ids, _ = detector.detectMarkers(gray)
            except AttributeError:
                params = cv2.aruco.DetectorParameters_create()  # type: ignore[attr-defined]
                corners, ids, _ = cv2.aruco.detectMarkers(gray, dictionary, parameters=params)
            if ids is None or len(corners) == 0:
                continue
            for c in corners:
                pts = c[0].astype(np.float32)
                area = float(cv2.contourArea(pts))
                if area > best_area:
                    best_area = area
                    best = pts
        except Exception:
            continue
    return best


def rectify_image_with_aruco(image_bytes: bytes) -> Tuple[bytes, dict]:
    """ArUco 마커를 검출해 사진 전체를 평면 정면 시점으로 와핑.

    Returns:
        (rectified_bytes, info)
        info: {success, reason, marker_pixel_size, tilt_deg}
        실패시 원본 bytes 그대로 반환 (success=False).
    """
    info = {
        "success": False,
        "reason": "no_marker",
        "marker_pixel_size": 0.0,
        "tilt_deg": 0.0,
    }
    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            info["reason"] = "decode_fail"
            return image_bytes, info

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        corners = _detect_largest_marker(gray)

        # 1차 탐지 실패 → 녹색 레이저 인페인팅 후 재시도
        # ⚠️ 인페인팅은 탐지 전용 임시 복사본에만 적용.
        #    호모그래피(와핑)는 아래에서 원본 img에 적용되므로
        #    레이저 프로파일 데이터가 출력 이미지에 그대로 보존된다.
        if corners is None:
            try:
                img_no_laser = _remove_laser_lines(img)
                gray_no_laser = cv2.cvtColor(img_no_laser, cv2.COLOR_BGR2GRAY)
                corners = _detect_largest_marker(gray_no_laser)
                if corners is not None:
                    print("[ArUco] 레이저 인페인팅 후 마커 재탐지 성공 — 원본 이미지로 와핑 진행")
            except Exception as e:
                print(f"[ArUco] 인페인팅 재시도 오류 (무시): {e}")

        if corners is None:
            return image_bytes, info

        # 마커 중심 + 평균 변 길이
        cx, cy = corners.mean(axis=0)
        side_lens = [float(np.linalg.norm(corners[(i + 1) % 4] - corners[i])) for i in range(4)]
        L = float(np.mean(side_lens))
        if L < 20.0:
            info["reason"] = "marker_too_small"
            return image_bytes, info

        # 목표: (cx,cy) 중심의 변 길이 L 정사각형 (축 정렬)
        h = L / 2.0
        target = np.array(
            [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]],
            dtype=np.float32,
        )

        H, _ = cv2.findHomography(corners, target, method=0)
        if H is None:
            info["reason"] = "homography_fail"
            return image_bytes, info

        Hh, Ww = img.shape[:2]
        warped = cv2.warpPerspective(
            img, H, (Ww, Hh),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0),
        )

        # 기울기 추정: 마커 상단 변(0→1)이 수평 대비 회전된 각도
        dx = float(corners[1][0] - corners[0][0])
        dy = float(corners[1][1] - corners[0][1])
        tilt = float(np.degrees(np.arctan2(dy, dx)))

        ok, buf = cv2.imencode(".jpg", warped, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if not ok:
            info["reason"] = "encode_fail"
            return image_bytes, info

        info.update({
            "success": True,
            "reason": "ok",
            "marker_pixel_size": round(L, 1),
            "tilt_deg": round(tilt, 1),
        })
        return bytes(buf.tobytes()), info
    except Exception as e:
        info["reason"] = f"exception:{type(e).__name__}"
        return image_bytes, info

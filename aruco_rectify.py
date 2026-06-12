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


def _preprocess_for_aruco(gray: np.ndarray) -> np.ndarray:
    """레이저 선을 이진화 + 형태학적 닫기로 제거한 임시 이진 이미지 반환.

    ⚠️  이 함수의 출력은 마커 코너 탐지에만 사용된다.
        호모그래피(와핑)와 레이저 프로파일 분석은 반드시
        원본 이미지(Original Image)로 진행해야 한다.

    파이프라인:
      1. adaptiveThreshold (THRESH_BINARY_INV, Gaussian, blockSize=15, C=4):
         어두운 마커 픽셀 → 255 (흰색 전경),
         밝은 레이저/배경 → 0 (검정 배경).
         이 반전 표현에서 레이저 선은 마커 내부의 얇은 검정 구멍이 된다.
      2. MORPH_CLOSE (5×5 np.ones 커널, 1회):
         검정(0) 구멍을 주변 흰색(255) 마커 픽셀로 메움.
         → 레이저 선이 마커와 동일한 흰색으로 복원됨.
      3. bitwise_not:
         표준 ArUco 입력 규격(어두운 마커, 밝은 배경)으로 복원.

    적색 레이저 확장 옵션 (필요 시 HSV 마스크 단계 추가 가능 — 주석 준비):
      Red H: 0–10 / 165–179, S·V: 100–255
    """
    # 1. 반전 이진화: 어두운 마커 → 흰색, 밝은 레이저/배경 → 검정
    binary_inv = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        blockSize=15,
        C=4,
    )

    # 2. 닫기 연산: 마커 흰색 영역 내부의 얇은 검정 레이저 선(구멍) 메우기
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(binary_inv, cv2.MORPH_CLOSE, kernel)

    # 3. 표준 ArUco 방향으로 복원 (어두운 마커, 밝은 배경)
    return cv2.bitwise_not(closed)

    # ── 적색 레이저 추가 전처리 옵션 (HSV 방식, 필요 시 활성화) ────
    # img_bgr 이 필요하므로 시그니처 변경 후 아래 주석 해제:
    # hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    # red_lo1 = np.array([  0, 100, 100], dtype=np.uint8)
    # red_hi1 = np.array([ 10, 255, 255], dtype=np.uint8)
    # red_lo2 = np.array([165, 100, 100], dtype=np.uint8)
    # red_hi2 = np.array([179, 255, 255], dtype=np.uint8)
    # red_mask = cv2.bitwise_or(cv2.inRange(hsv, red_lo1, red_hi1),
    #                           cv2.inRange(hsv, red_lo2, red_hi2))
    # (이후 마스크로 binary_inv 의 해당 픽셀을 255 로 강제 설정)


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

        # 1차 탐지 실패 → 이진화+닫기 전처리 후 재시도
        # ⚠️ 전처리 이미지는 탐지 전용 임시 사본.
        #    호모그래피(와핑)는 원본 img 에만 적용되므로
        #    레이저 프로파일 데이터가 출력 이미지에 그대로 보존된다.
        if corners is None:
            try:
                binary = _preprocess_for_aruco(gray)
                corners = _detect_largest_marker(binary)
                if corners is not None:
                    print("[ArUco] 이진화+닫기 전처리 후 마커 재탐지 성공 — 원본 이미지로 와핑 진행")
            except Exception as e:
                print(f"[ArUco] 전처리 재시도 오류 (무시): {e}")

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

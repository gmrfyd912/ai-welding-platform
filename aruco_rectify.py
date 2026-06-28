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


def _preprocess_for_aruco(img: np.ndarray) -> np.ndarray:
    """BGR → 흑백 적응형 이진화. 1차 탐지 실패 시 재시도용 탐지 전용 이미지 반환.

    ⚠️  이 함수의 출력은 마커 코너 탐지에만 사용된다.
        호모그래피(와핑)와 레이저 프로파일 분석은 반드시
        원본 BGR 이미지(Original Image)로 진행해야 한다.

    고급 레이저 제거가 필요하면 advanced_filters.py 의
    remove_laser_via_fft / remove_laser_via_frangi 를 호출한 뒤
    결과 이미지에 이 이진화를 적용하라.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=15,
        C=4,
    )


def _make_aruco_params():
    """산업 현장형 DetectorParameters 생성.

    용접 철판의 금속 반사(글레어), 불균일 조명, 원거리 촬영에서
    마커 탐지율을 높이기 위한 파라미터 세트.
    새 API(OpenCV 4.7+)와 구 API 모두 지원.
    """
    try:
        p = cv2.aruco.DetectorParameters()
    except AttributeError:
        p = cv2.aruco.DetectorParameters_create()  # type: ignore[attr-defined]

    # 이진화 블록 크기 범위 확장: 작은 마커(원거리)~큰 마커(근거리) 모두 대응
    p.adaptiveThreshWinSizeMin  = 3
    p.adaptiveThreshWinSizeMax  = 53
    p.adaptiveThreshWinSizeStep = 4
    p.adaptiveThreshConstant    = 4   # 노이즈로 인한 이진화 훼손 방지

    # 원거리 소형 마커도 검출 (기본값 0.03 → 0.01)
    p.minMarkerPerimeterRate = 0.01

    # 반사/오염으로 마커 비트 일부 손상되어도 복구 (기본값 0.6 → 0.9)
    p.errorCorrectionRate = 0.9

    return p


def _detect_largest_marker(gray: np.ndarray) -> Optional[np.ndarray]:
    """여러 ArUco 사전을 순회하며 가장 큰(면적 최대) 마커 4 모서리 반환."""
    best: Optional[np.ndarray] = None
    best_area = 0.0
    params = _make_aruco_params()
    for dict_id in _DICT_IDS:
        try:
            dictionary = cv2.aruco.getPredefinedDictionary(dict_id)
            try:
                detector = cv2.aruco.ArucoDetector(dictionary, params)
                corners, ids, _ = detector.detectMarkers(gray)
            except AttributeError:
                corners, ids, _ = cv2.aruco.detectMarkers(  # type: ignore[attr-defined]
                    gray, dictionary, parameters=params
                )
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

        # 1차 탐지 실패 → 적응형 이진화 전처리 후 재시도
        # ⚠️ 전처리 이미지(binary)는 탐지 전용 임시 사본.
        #    호모그래피(와핑)는 원본 img 에만 적용되므로
        #    레이저 프로파일 데이터가 출력 이미지에 그대로 보존된다.
        if corners is None:
            try:
                binary = _preprocess_for_aruco(img)
                corners = _detect_largest_marker(binary)
                if corners is not None:
                    print("[ArUco] 적응형 이진화 전처리 후 마커 재탐지 성공 — 원본 이미지로 와핑 진행")
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

        # ── 촬영 앵글 동적 추정 ────────────────────────────────────────────────
        # 마커는 30mm 정사각형. 카메라 앙각 θ에서 한 방향이 sin(θ)로 압축.
        # side_lens: [상, 우, 하, 좌] → 수평(0,2): top+bottom, 수직(1,3): right+left
        horiz_avg = (side_lens[0] + side_lens[2]) / 2.0
        vert_avg  = (side_lens[1] + side_lens[3]) / 2.0
        if horiz_avg > 5.0 and vert_avg > 5.0:
            compression = min(horiz_avg, vert_avg) / max(horiz_avg, vert_avg)
            compression = max(0.10, min(1.0, compression))
            shooting_est = round(float(np.degrees(np.arcsin(compression))), 1)
        else:
            shooting_est = 90.0
        info["shooting_angle_est_deg"] = shooting_est

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

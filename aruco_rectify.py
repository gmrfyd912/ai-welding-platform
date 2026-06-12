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
from skimage.filters import frangi as _skimage_frangi


_DICT_IDS = [
    cv2.aruco.DICT_4X4_50,  cv2.aruco.DICT_4X4_100, cv2.aruco.DICT_4X4_250,
    cv2.aruco.DICT_5X5_50,  cv2.aruco.DICT_5X5_100, cv2.aruco.DICT_5X5_250,
    cv2.aruco.DICT_6X6_50,  cv2.aruco.DICT_6X6_100, cv2.aruco.DICT_6X6_250,
    cv2.aruco.DICT_7X7_50,  cv2.aruco.DICT_7X7_100,
    cv2.aruco.DICT_ARUCO_ORIGINAL,
]


def remove_laser_via_frangi(
    img_bgr: np.ndarray,
    sigmas: tuple = (1, 2, 3),
    dilate_ksize: int = 5,
    inpaint_radius: int = 3,
) -> np.ndarray:
    """Frangi Vesselness Filter로 레이저 선을 탐지·인페인팅 제거한 BGR 이미지 반환.

    ⚠️  전처리·탐지 전용 함수. 레이저 프로파일/비드 분석에는 원본 BGR을 사용할 것.

    설계 근거:
      Frangi 필터(의료 혈관 탐지 알고리즘)는 Hessian 행렬의 고유값 비율로
      선(Ridge) 구조를 탐지함. 원근 왜곡으로 격자 주기성이 깨지더라도
      레이저 선은 국소적으로 Ridge 구조를 유지하므로 탐지 가능.
      black_ridges=False → 어두운 배경 위 밝은 선(레이저) 탐지.

    파이프라인:
      1. BGR → Grayscale.
      2. frangi(sigmas=(1,2,3), black_ridges=False):
         얇은 선 폭에 맞춘 멀티스케일 Ridge 탐지 → Vesselness float64 [0,1].
      3. Vesselness → 0–255 정규화 → Otsu 임계값 → 이진 laser_mask.
         Otsu: 이미지별 최적 분리점 자동 산출 → 고정 임계값보다 강건.
      4. laser_mask에 5×5 타원 커널 팽창(1회):
         빛 번짐(Halo) 및 Ridge 경계 잔류 픽셀까지 커버.
      5. cv2.inpaint(INPAINT_TELEA, radius=3):
         마스크 내 픽셀을 주변 배경 텍스처로 자연스럽게 복원.
      6. 레이저 선이 탐지되지 않으면(vesselness 모두 0) 원본 반환.

    Args:
        sigmas:         Frangi 스케일 범위. 기본 (1, 2, 3) — 얇은 레이저 선.
        dilate_ksize:   마스크 팽창 커널 크기 (px). 기본 5.
        inpaint_radius: TELEA 인페인팅 반경 (px). 기본 3.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # 1+2. Frangi Vesselness: 밝은 선 구조 추출 (float64, 0~1)
    vesselness = _skimage_frangi(
        gray.astype(np.float64),
        sigmas=sigmas,
        black_ridges=False,
    )

    # 3. 0–255 정규화 → Otsu 임계값으로 이진 laser_mask 생성
    v_min, v_max = float(vesselness.min()), float(vesselness.max())
    if v_max <= v_min:
        return img_bgr.copy()  # 레이저 선 없음 → 원본 반환

    vesselness_u8 = ((vesselness - v_min) / (v_max - v_min) * 255).astype(np.uint8)
    _, laser_mask = cv2.threshold(
        vesselness_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    # 4. 빛 번짐(Halo) 영역 커버 — 타원 커널 팽창
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (dilate_ksize, dilate_ksize)
    )
    laser_mask = cv2.dilate(laser_mask, kernel, iterations=1)

    # 5. TELEA 인페인팅으로 레이저 선 주변 배경 텍스처로 복원
    return cv2.inpaint(img_bgr, laser_mask, inpaintRadius=inpaint_radius,
                       flags=cv2.INPAINT_TELEA)


def _preprocess_for_aruco(img: np.ndarray) -> np.ndarray:
    """Frangi 레이저 제거 + 적응형 이진화로 ArUco 탐지용 이미지 반환.

    ⚠️  이 함수의 출력은 마커 코너 탐지에만 사용된다.
        호모그래피(와핑)와 레이저 프로파일 분석은 반드시
        원본 BGR 이미지(Original Image)로 진행해야 한다.
    """
    cleaned_bgr = remove_laser_via_frangi(img)
    gray = cv2.cvtColor(cleaned_bgr, cv2.COLOR_BGR2GRAY)
    return cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=15,
        C=4,
    )


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

        # 1차 탐지 실패 → Frangi 레이저 제거 전처리 후 재시도
        # ⚠️ 전처리 이미지(binary)는 탐지 전용 임시 사본.
        #    호모그래피(와핑)는 원본 img 에만 적용되므로
        #    레이저 프로파일 데이터가 출력 이미지에 그대로 보존된다.
        if corners is None:
            try:
                binary = _preprocess_for_aruco(img)
                corners = _detect_largest_marker(binary)
                if corners is not None:
                    print("[ArUco] Frangi 레이저 제거 전처리 후 마커 재탐지 성공 — 원본 이미지로 와핑 진행")
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

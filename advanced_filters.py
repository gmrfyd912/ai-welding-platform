"""고급 레이저 제거 알고리즘 보관 모듈.

핵심 파이프라인(aruco_rectify.py)에서 분리 보관.
현장 조건 변화 시 아래 함수를 aruco_rectify._preprocess_for_aruco 에서
호출하는 것만으로 즉시 재활성화 가능.

사용 예:
    from advanced_filters import remove_laser_via_fft, remove_laser_via_frangi
"""
from __future__ import annotations

import cv2
import numpy as np
from skimage.filters import frangi as _skimage_frangi


# ──────────────────────────────────────────────────────────────────────────────
# 1. 2D FFT Notch Filter
#    대상 : 주기적 격자 레이저 (원근 왜곡이 적을 때 유효)
# ──────────────────────────────────────────────────────────────────────────────

def remove_laser_via_fft(
    img_bgr: np.ndarray,
    center_radius: int = 40,
    notch_radius: int = 8,
    peak_sigma: float = 3.0,
) -> np.ndarray:
    """2D FFT Notch Filter로 주기성 격자 레이저 노이즈를 제거한 uint8 Grayscale 반환.

    설계 근거 (수학적/논리적):
      격자 레이저는 공간상에서 주기적(Periodic) 패턴 → 2D FFT 스펙트럼에서
      DC 중앙에서 떨어진 고주파 위치에 임펄스(날카로운 피크)로 집중됨.
      마커/비드의 형태 정보는 저주파(중앙 근처)에 집중됨.

        ① 중앙 center_radius(기본 40px) 이내 → 저주파 보존 (mask = 1).
        ② 중앙 외부: 통계적 임계값 T = μ + peak_sigma·σ 초과 피크 탐지.
           (외부 픽셀 평균·표준편차 기반 → 조명·해상도 변화에 강건)
        ③ 각 피크를 notch_radius(기본 8px) 반경 타원 커널로 팽창 →
           Notch 영역 → mask = 0 (차단).
        ④ 저주파 영역 최종 강제 복원 (mask[center_region] = 1).
        ⑤ IFFT → 복소수 절대값 → 0–255 정규화 → uint8.

    주의: 원근 왜곡으로 격자 주기성이 깨지면 FFT 피크가 분산되어
          효과가 저하될 수 있음. 그런 경우 remove_laser_via_frangi 사용.

    Args:
        center_radius: 저주파 보존 반경 (px). 기본 40.
        notch_radius:  각 피크 Notch 반경 (px). 기본 8.
        peak_sigma:    피크 탐지 임계값 계수 (μ + σ배). 기본 3.0.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    H, W = gray.shape
    cy, cx = H // 2, W // 2

    # 주파수 도메인 변환 (DC를 중앙으로 이동)
    fshift = np.fft.fftshift(np.fft.fft2(gray))
    magnitude = np.abs(fshift)

    # 중앙 저주파 영역 정의
    Y, X = np.ogrid[:H, :W]
    dist = np.sqrt((Y - cy) ** 2 + (X - cx) ** 2)
    center_region = dist <= center_radius

    # 외부 고주파 영역에서 레이저 피크 동적 탐지
    outer_mag = magnitude.copy()
    outer_mag[center_region] = 0.0
    outer_vals = outer_mag[~center_region]
    threshold = float(outer_vals.mean() + peak_sigma * outer_vals.std())

    peak_binary = (outer_mag > threshold).astype(np.uint8)
    ellipse_k = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (notch_radius * 2 + 1, notch_radius * 2 + 1)
    )
    notch_region = cv2.dilate(peak_binary, ellipse_k)

    # Notch Filter 마스크 구성 및 적용
    mask = np.ones((H, W), dtype=np.float32)
    mask[notch_region > 0] = 0.0
    mask[center_region] = 1.0  # 저주파 항상 보존

    # 역 FFT → 공간 도메인 복원
    f_filtered = np.fft.ifft2(np.fft.ifftshift(fshift * mask))
    cleaned = np.abs(f_filtered)  # 켤레 비대칭으로 생긴 잔류 허수부 제거

    # 0–255 정규화
    c_min, c_max = float(cleaned.min()), float(cleaned.max())
    if c_max > c_min:
        cleaned = (cleaned - c_min) / (c_max - c_min) * 255.0
    else:
        cleaned = np.zeros_like(cleaned)
    return cleaned.astype(np.uint8)


# ──────────────────────────────────────────────────────────────────────────────
# 2. Frangi Vesselness Filter
#    대상 : 원근 왜곡된 격자 레이저 (주기성이 깨져도 Ridge 구조는 유지)
# ──────────────────────────────────────────────────────────────────────────────

def remove_laser_via_frangi(
    img_bgr: np.ndarray,
    sigmas: tuple = (1, 2, 3),
    dilate_ksize: int = 5,
    inpaint_radius: int = 3,
) -> np.ndarray:
    """Frangi Vesselness Filter로 레이저 선을 탐지·인페인팅 제거한 BGR 이미지 반환.

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

    # Frangi Vesselness: 밝은 선 구조 추출 (float64, 0~1)
    vesselness = _skimage_frangi(
        gray.astype(np.float64),
        sigmas=sigmas,
        black_ridges=False,
    )

    # 0–255 정규화 → Otsu 임계값으로 이진 laser_mask 생성
    v_min, v_max = float(vesselness.min()), float(vesselness.max())
    if v_max <= v_min:
        return img_bgr.copy()  # 레이저 선 없음 → 원본 반환

    vesselness_u8 = ((vesselness - v_min) / (v_max - v_min) * 255).astype(np.uint8)
    _, laser_mask = cv2.threshold(
        vesselness_u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    # 빛 번짐(Halo) 영역 커버 — 타원 커널 팽창
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (dilate_ksize, dilate_ksize)
    )
    laser_mask = cv2.dilate(laser_mask, kernel, iterations=1)

    # TELEA 인페인팅으로 레이저 선 주변 배경 텍스처로 복원
    return cv2.inpaint(img_bgr, laser_mask, inpaintRadius=inpaint_radius,
                       flags=cv2.INPAINT_TELEA)

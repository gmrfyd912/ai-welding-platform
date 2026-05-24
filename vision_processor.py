import cv2
import numpy as np
import math


def _robust_polyfit(ts: np.ndarray, ds: np.ndarray, degree: int, n_iter: int = 3):
    """
    IRLS(Iteratively Reweighted Least Squares) Huber-가중 polyfit.

    일반 polyfit은 모든 점에 같은 가중치를 줘서, 비드가 한 곳만 살짝
    구부러져 있어도 그 wobble이 곡선을 끌어당겨 기준선이 휘어버린다.
    IRLS는 잔차(residual)가 큰 점일수록 가중치를 줄여가며 재적합 →
    "본체의 평균 경로"를 따라가는 강건한 기준 곡선을 얻는다.

    1. 보통 polyfit 으로 1차 곡선 fit
    2. 각 점의 잔차 r_i 계산
    3. MAD(중앙절대편차)로 잔차 스케일 σ ≈ 1.4826 × MAD 추정
    4. |r_i| ≤ 1.5σ → 가중치 1
       |r_i| >  1.5σ → 가중치 (1.5σ / |r_i|)  (이상치는 약하게 반영)
    5. 가중 polyfit 으로 곡선 갱신, 2~3 회 반복
    """
    ts = np.asarray(ts, dtype=np.float64)
    ds = np.asarray(ds, dtype=np.float64)
    if len(ts) < degree + 1:
        return None
    try:
        weights = np.ones_like(ts, dtype=np.float64)
        coeffs = np.polyfit(ts, ds, degree, w=weights)
        for _ in range(n_iter):
            poly = np.poly1d(coeffs)
            residuals = ds - poly(ts)
            mad = float(np.median(np.abs(residuals - np.median(residuals))))
            if mad < 1e-9:
                break
            sigma = 1.4826 * mad
            thresh = 1.5 * sigma
            abs_r = np.abs(residuals)
            weights = np.where(abs_r <= thresh, 1.0, thresh / np.maximum(abs_r, 1e-9))
            try:
                coeffs = np.polyfit(ts, ds, degree, w=weights)
            except Exception:
                break
        return coeffs
    except Exception:
        return None


def _densify_polygon(pts_xy: np.ndarray, max_seg_len_px: float = 3.0) -> np.ndarray:
    """폴리곤 변(edge)을 짧은 픽셀 간격으로 잘게 보간한다.

    Roboflow 가 보내주는 비드 폴리곤은 경계 꼭짓점이 희박하고 변마다
    길이 편차가 크다. 그대로 ±half_window 슬라이스로 폭을 측정하면
    슬라이스마다 잡히는 점 수가 들쭉날쭉해서 (위/아래 변을 모두 잡는
    슬라이스는 정확한 폭, 한쪽 변만 잡는 슬라이스는 비정상으로 작은 폭)
    측정값 분포가 양극화 되고 IQR(P75-P25)이 부풀려진다.

    각 변을 ~3px 간격으로 보간하면 모든 슬라이스가 위·아래 양쪽
    경계점을 충분히 잡아 진짜 비드 폭을 일관되게 측정할 수 있다.
    """
    if pts_xy is None or len(pts_xy) < 2:
        return pts_xy
    out = []
    n = len(pts_xy)
    for i in range(n):
        p0 = pts_xy[i]
        p1 = pts_xy[(i + 1) % n]
        dx = float(p1[0] - p0[0])
        dy = float(p1[1] - p0[1])
        seg_len = math.sqrt(dx * dx + dy * dy)
        n_sub = max(1, int(math.ceil(seg_len / max_seg_len_px)))
        for k in range(n_sub):
            t = k / n_sub
            out.append((float(p0[0]) + dx * t, float(p0[1]) + dy * t))
    return np.array(out, dtype=np.float64)


def analyze_laser_grid(image_bytes: bytes, ppm: float,
                       laser_angle_deg: float = 45.0,
                       bead_polygon_pct: list = None) -> dict:
    """
    DOE 격자 레이저 분석으로 비드 높이/오목볼록도 측정.

    원리:
    - 평탄면: 격자선이 직선
    - 비드 위: 격자선이 휘어짐
    - 휘어진 정도 + 레이저 각도 → 실제 높이(mm)

    공식: h = 격자변형량(px) / ppm / tan(laser_angle_deg)
    """
    try:
        # [1단계] 이미지 로드 및 전처리
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return {"status": "error", "message": "이미지 디코딩 실패"}

        h_img, w_img = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 50, 150)

        # [2단계] 격자선 검출
        lines_raw = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=50,
                                    minLineLength=30, maxLineGap=10)
        if lines_raw is None or len(lines_raw) == 0:
            return {"status": "error", "message": "격자선을 검출하지 못했습니다"}

        h_lines = []  # (center_y, center_x, x1, y1, x2, y2, length)
        v_lines = []

        for line in lines_raw:
            x1, y1, x2, y2 = line[0]
            length = math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
            if length < 30:
                continue
            angle = abs(math.degrees(math.atan2(y2 - y1, x2 - x1)))
            center_y = (y1 + y2) / 2.0
            center_x = (x1 + x2) / 2.0
            if angle <= 15 or angle >= 165:
                h_lines.append((center_y, center_x, x1, y1, x2, y2, length))
            elif 75 <= angle <= 105:
                v_lines.append((center_x, center_y, x1, y1, x2, y2, length))

        if len(h_lines) < 3:
            return {"status": "error", "message": f"수평 격자선 부족 ({len(h_lines)}개 검출)"}

        # [3단계] 비드 영역 vs 평탄 영역 분리
        if bead_polygon_pct:
            xs = [p["x_pct"] * w_img / 100 for p in bead_polygon_pct]
            ys = [p["y_pct"] * h_img / 100 for p in bead_polygon_pct]
            bead_y_min = int(min(ys))
            bead_y_max = int(max(ys))
            bead_x_min = int(min(xs))
            bead_x_max = int(max(xs))
        else:
            bead_y_min = int(h_img * 0.30)
            bead_y_max = int(h_img * 0.70)
            bead_x_min = int(w_img * 0.30)
            bead_x_max = int(w_img * 0.70)

        bead_center_y = (bead_y_min + bead_y_max) / 2.0

        # [4단계] 기준 격자 간격 계산 (평탄면 기준)
        flat_ys = sorted([
            cy for (cy, cx, x1, y1, x2, y2, length) in h_lines
            if cy < bead_y_min or cy > bead_y_max
        ])
        if len(flat_ys) >= 2:
            spacings = [
                flat_ys[i + 1] - flat_ys[i]
                for i in range(len(flat_ys) - 1)
                if flat_ys[i + 1] - flat_ys[i] > 5
            ]
            ref_spacing_px = float(np.median(spacings)) if spacings else 20.0
        else:
            ref_spacing_px = 20.0

        laser_grid_spacing_mm = round(ref_spacing_px / ppm, 2)

        # [5단계] 비드 위 격자 변형량 측정
        bead_h_lines = [
            (cy, cx, x1, y1, x2, y2, length)
            for (cy, cx, x1, y1, x2, y2, length) in h_lines
            if bead_y_min <= cy <= bead_y_max
        ]

        n_segments = 10
        x_range = max(bead_x_max - bead_x_min, 1)
        tan_angle = max(math.tan(math.radians(laser_angle_deg)), 1e-9)

        # 비드 중앙 y에 대한 예상 격자선 y (평탄면 기준 보간)
        above_ys = [cy for cy in flat_ys if cy < bead_y_min]
        below_ys = [cy for cy in flat_ys if cy > bead_y_max]
        if above_ys and below_ys:
            n_steps = round((bead_center_y - above_ys[-1]) / ref_spacing_px)
            expected_center_y = above_ys[-1] + n_steps * ref_spacing_px
        elif above_ys:
            n_steps = round((bead_center_y - above_ys[-1]) / ref_spacing_px)
            expected_center_y = above_ys[-1] + n_steps * ref_spacing_px
        elif below_ys:
            n_steps = round((below_ys[0] - bead_center_y) / ref_spacing_px)
            expected_center_y = below_ys[0] - n_steps * ref_spacing_px
        else:
            expected_center_y = bead_center_y

        profile = []
        heights_mm = []

        for i in range(n_segments):
            x_lo = bead_x_min + i * x_range / n_segments
            x_hi = bead_x_min + (i + 1) * x_range / n_segments
            x_center = (x_lo + x_hi) / 2.0
            x_pct = round(x_center / w_img * 100, 2)

            # 이 x 구간에서 비드 위 수평선의 실제 y
            seg_ys = []
            for (cy, cx, x1, y1, x2, y2, length) in bead_h_lines:
                lx_min = min(x1, x2)
                lx_max = max(x1, x2)
                if lx_max >= x_lo and lx_min <= x_hi:
                    if x2 != x1:
                        t = max(0.0, min(1.0, (x_center - x1) / (x2 - x1)))
                        y_interp = y1 + t * (y2 - y1)
                    else:
                        y_interp = (y1 + y2) / 2.0
                    seg_ys.append(y_interp)

            if not seg_ys:
                continue

            actual_y = float(np.median(seg_ys))
            # [6단계] 양수 = 위로 휨 = 볼록 (비드 솟아오름)
            deformation_px = expected_center_y - actual_y
            height_mm = round(deformation_px / ppm / tan_angle, 2)
            heights_mm.append(height_mm)
            profile.append({"x_pct": x_pct, "height_mm": height_mm})

        if not heights_mm:
            return {"status": "error", "message": "비드 위 격자 변형을 측정하지 못했습니다"}

        # [7단계] 프로파일 통계
        arr = np.array(heights_mm, dtype=np.float64)
        max_h = round(float(arr.max()), 2)
        min_h = round(float(arr.min()), 2)
        avg_h = round(float(arr.mean()), 2)
        variance = round(float(max_h - min_h), 2)

        if avg_h > 0.5:
            convexity = "convex"
        elif avg_h < -0.5:
            convexity = "concave"
        else:
            convexity = "flat"

        # [8단계] 격자선 시각화 데이터
        grid_lines_vis = []
        for (cy, cx, x1, y1, x2, y2, length) in h_lines[:20]:
            grid_lines_vis.append({
                "x1_pct": round(x1 / w_img * 100, 2),
                "y1_pct": round(y1 / h_img * 100, 2),
                "x2_pct": round(x2 / w_img * 100, 2),
                "y2_pct": round(y2 / h_img * 100, 2),
                "type": "horizontal",
            })
        for (cx, cy, x1, y1, x2, y2, length) in v_lines[:10]:
            grid_lines_vis.append({
                "x1_pct": round(x1 / w_img * 100, 2),
                "y1_pct": round(y1 / h_img * 100, 2),
                "x2_pct": round(x2 / w_img * 100, 2),
                "y2_pct": round(y2 / h_img * 100, 2),
                "type": "vertical",
            })

        worst_idx = int(np.argmax(np.abs(arr)))
        worst_pt = profile[worst_idx] if worst_idx < len(profile) else None

        return {
            "status": "success",
            "beadHeightMax": max_h,
            "beadHeightMin": min_h,
            "beadHeightAvg": avg_h,
            "heightVariance": variance,
            "convexity": convexity,
            "convexityMm": round(abs(avg_h), 2),
            "laserGridSpacingMm": laser_grid_spacing_mm,
            "profile": profile,
            "gridLines": grid_lines_vis,
            "worstPoint": {
                "x_pct": worst_pt["x_pct"],
                "y_pct": round(bead_center_y / h_img * 100, 2),
                "height_mm": heights_mm[worst_idx],
            } if worst_pt else None,
            "message": (f"격자 간격 {laser_grid_spacing_mm}mm | "
                        f"수평선 {len(h_lines)}개 검출"),
        }

    except Exception as e:
        return {"status": "error", "message": f"레이저 격자 분석 오류: {str(e)}"}


def analyze_bead_dimensions(predictions, marker_real_size_mm=30.0, is_pipe=False,
                            pipe_outer_diameter_mm: float = 0.0,
                            has_laser: bool = False,
                            laser_angle_deg: float = 45.0,
                            image_bytes: bytes = None):
    """
    비드 폭 / 직진도 분석.

    핵심 개념
    ----------
    - 비드 폭(width)         : 각 장축 구간에서 (외곽선 max_d - min_d)
    - 비드 중심선(centerline): 각 장축 구간의 (max_d + min_d) / 2
    - 직진도(straightness)   : "중심선"이 기준선에서 얼마나 벗어나는가
        · 평판(is_pipe=False) : 기준선 = 직선 (cv2.fitLine, d=0)
        · 배관(is_pipe=True ) : 기준선 = 중심선들에 fit 한 2차 곡선 polyfit

    ⚠️ 이전 버전은 외곽선 점들의 d값을 그대로 "이탈"로 썼기 때문에
       폭이 26mm인 일자 비드도 "13mm 이탈"로 잡혀 빵점이 나왔음.
       반드시 중심선 기준으로만 직진도를 계산해야 함.
    """
    marker_pred = next((p for p in predictions if p.get('class') == 'Reference_Marker'), None)

    if not marker_pred:
        return {"status": "error", "message": "사진에서 30mm 마커(Reference_Marker)를 찾을 수 없습니다."}

    marker_pixel_width = marker_pred['width']
    ppm = marker_pixel_width / marker_real_size_mm

    image_width = marker_pred.get('image_width', 1000) or 1000
    image_height = marker_pred.get('image_height', 1000) or 1000

    bead_widths_mm = []
    straightness_variances = []
    straightness_lines = []  # 기준선 + 최대이탈점 (시각화용)
    defects_info = []

    # ── Weld_Bead 폴리곤 중 가장 큰 것 1개만 선택 ──
    # Roboflow가 같은 비드를 여러 인스턴스로 중복 검출하면 중심선이 여러 개
    # 그려지는 문제가 있어서, 가장 면적이 큰(=주 비드) 폴리곤 1개만 사용한다.
    bead_candidates = []
    for pred in predictions:
        if pred.get('class') != 'Weld_Bead':
            continue
        if 'points' not in pred or len(pred['points']) < 3:
            continue
        pts_tmp = np.array([[p['x'], p['y']] for p in pred['points']], dtype=np.float32)
        try:
            area_tmp = float(cv2.contourArea(pts_tmp))
        except Exception:
            area_tmp = 0.0
        bead_candidates.append((area_tmp, pred, pts_tmp))
    bead_candidates.sort(key=lambda x: x[0], reverse=True)
    main_bead = bead_candidates[0] if bead_candidates else None
    if main_bead is not None and len(bead_candidates) > 1:
        print(f"[Vision] Weld_Bead {len(bead_candidates)}개 검출 → "
              f"가장 큰 폴리곤(면적 {main_bead[0]:.0f}px²) 1개만 사용")

    for pred in predictions:
        cls_name = pred.get('class', '')

        if cls_name == 'Weld_Bead':
            # 메인 비드 1개만 처리, 나머지 Weld_Bead 인스턴스는 무시
            if main_bead is None or pred is not main_bead[1]:
                continue
            pts = main_bead[2]

            # ── 비드 장축 방향 결정: cv2.minAreaRect 사용 ──
            # 이전에는 cv2.fitLine(DIST_L2)을 썼는데, 폴리곤 점이 코너/끝점에
            # 군집되어 있으면 직선이 그쪽으로 기울어져 "수직 폭"이 실제 폭과
            # 달라지고, 그 결과 (max-min) 폭 변동이 인위적으로 커지는 문제가
            # 있었음. minAreaRect는 폴리곤을 감싸는 최소 면적 사각형의 긴 변을
            # 골라주므로 길쭉한 비드의 실제 장축을 안정적으로 잡아낸다.
            try:
                rect = cv2.minAreaRect(pts.astype(np.float32))
                (rect_cx, rect_cy), (rect_w, rect_h), rect_angle = rect
                # angle은 OpenCV 관습상 [-90, 0). 긴 변이 어느 쪽인지로 보정
                if rect_w >= rect_h:
                    long_angle_deg = rect_angle
                else:
                    long_angle_deg = rect_angle + 90.0
                long_angle_rad = math.radians(long_angle_deg)
                ux, uy = math.cos(long_angle_rad), math.sin(long_angle_rad)
                nx, ny = -uy, ux
                ox, oy = float(rect_cx), float(rect_cy)
            except Exception:
                # 폴백: cv2.fitLine
                [lvx, lvy, lx0, ly0] = cv2.fitLine(pts, cv2.DIST_L2, 0, 0.01, 0.01)
                ux, uy = float(lvx[0]), float(lvy[0])
                nx, ny = -uy, ux
                ox, oy = float(lx0[0]), float(ly0[0])

            # ── 폴리곤 변을 미세 보간 (~3px 간격) ──
            # 원본 Roboflow 꼭짓점이 sparse 해서 슬라이스마다 위/아래 변 잡힘이
            # 들쭉날쭉 → 폭 IQR 부풀림 + mid_d (중심선) 가 위/아래 한쪽으로 편향.
            # 보간된 점을 쓰면 모든 슬라이스가 양변을 충분히 잡아 진짜 중심을 잡음.
            dense_pts = _densify_polygon(pts.astype(np.float64), max_seg_len_px=3.0)
            pts_t_local = (dense_pts[:, 0] - ox) * ux + (dense_pts[:, 1] - oy) * uy
            pts_d_local = (dense_pts[:, 0] - ox) * nx + (dense_pts[:, 1] - oy) * ny

            t_min, t_max = float(pts_t_local.min()), float(pts_t_local.max())
            long_len = t_max - t_min
            if long_len <= 0:
                continue

            # ── 장축을 N등분해서 각 구간 중심선(mid_d) 추출 ──
            # 폭은 여기서 측정하지 않는다(아래 reference curve 기준 측정으로 대체).
            # ⚠️ 중요: dense_pts 기준으로 mid_d 를 잡아야 위/아래 변이 모두 들어와
            #          진짜 비드 중심이 나온다 (sparse 꼭짓점이면 한쪽으로 편향).
            #
            # ⚠️ 한쪽-가장자리만 잡힌 슬라이스 필터 (중요!)
            # 비드 시작/끝 부분에서 폴리곤이 둥글게 말려있으면 어떤 슬라이스는
            # 위쪽 변만 (또는 아래쪽 변만) 잡혀서 (d_max+d_min)/2 가 한쪽으로
            # 치우친다. 이런 편향된 mid_d 가 polyfit 에 들어가면 기준선의
            # 좌/우 끝이 비드 중심에서 벗어나는 현상이 발생.
            # → 폭(d_max-d_min)이 중앙값의 50% 미만인 슬라이스는 신뢰 불가
            #   판정해서 polyfit 에서 제외한다.
            N_SEGMENTS = 20
            seg_width = long_len / N_SEGMENTS
            seg_raw = []  # (t_center, d_min, d_max)
            for i in range(N_SEGMENTS):
                s_lo = t_min + i * seg_width
                s_hi = t_min + (i + 1) * seg_width
                mask_seg = (pts_t_local >= s_lo) & (pts_t_local <= s_hi)
                if mask_seg.sum() >= 2:
                    seg_d = pts_d_local[mask_seg]
                    d_min_s = float(seg_d.min())
                    d_max_s = float(seg_d.max())
                    if d_max_s - d_min_s > 0:
                        t_center = (s_lo + s_hi) / 2.0
                        seg_raw.append((t_center, d_min_s, d_max_s))

            if not seg_raw:
                continue

            seg_widths_arr = np.array([w_max - w_min for (_, w_min, w_max) in seg_raw],
                                      dtype=np.float64)
            median_seg_w = float(np.median(seg_widths_arr))
            min_w_thresh = median_seg_w * 0.5
            seg_centerlines = [
                (t_c, (d_max_s + d_min_s) / 2.0)
                for (t_c, d_min_s, d_max_s) in seg_raw
                if (d_max_s - d_min_s) >= min_w_thresh
            ]
            if len(seg_centerlines) < 3:
                # 필터로 너무 많이 잘렸으면 폴백: 원본 사용
                seg_centerlines = [
                    (t_c, (d_max_s + d_min_s) / 2.0)
                    for (t_c, d_min_s, d_max_s) in seg_raw
                ]
            else:
                dropped = len(seg_raw) - len(seg_centerlines)
                if dropped > 0:
                    print(f"[Vision] 한쪽 변만 잡힌 슬라이스 {dropped}/{len(seg_raw)}개 제외 "
                          f"(폭 < {min_w_thresh:.1f}px) → 비드 중심선 편향 보정")

            # ── 단축(원근) 보정 helper (배관 + 외경 입력 시) ──
            R_px = (pipe_outer_diameter_mm / 2.0) * ppm if (is_pipe and pipe_outer_diameter_mm > 0) else 0.0
            cx_img = image_width / 2.0

            def _foreshorten_correct(w_pix: float, t_center: float) -> float:
                if R_px <= 0:
                    return w_pix
                gx = ox + t_center * ux
                xr = (gx - cx_img) / R_px
                if abs(xr) >= 0.95:
                    xr = 0.95 if xr > 0 else -0.95
                denom = math.sqrt(max(1.0 - xr * xr, 1e-6))
                return w_pix / denom

            ts_arr = np.array([c[0] for c in seg_centerlines], dtype=np.float64)
            ds_arr = np.array([c[1] for c in seg_centerlines], dtype=np.float64)

            # ⚠️ 평활화(3점 이동평균) 제거됨 ⚠️
            # 이전 버전은 시각적 노이즈를 줄이려고 raw 중심선에 3점 MA 를 적용했는데,
            # 실제 비드의 sharp wobble 피크가 깎여서 (예: raw 12 → smoothed 7.3)
            # 직진도 최대 이탈점 argmax 가 진짜 피크가 아닌 트림 경계 쪽으로
            # 잘못 이동하는 문제가 있었음 (사용자 보고: 빨간 점이 엉뚱한 곳에 찍힘).
            # polyfit 이 IRLS Huber 가중으로 robust 하므로 추가 평활화 불필요.

            # ── 본체 구간 트림 ──
            # 평판: 양 끝 10% 컷 (시점·끝점이 비교적 깔끔)
            # 배관: 양 끝 20% 컷 (시점·끝점이 곡면 왜곡 + 토치 정착/이탈 영향 큼)
            trim_pct = 0.20 if is_pipe else 0.10
            t_full_lo, t_full_hi = float(ts_arr[0]), float(ts_arr[-1])
            t_span = t_full_hi - t_full_lo
            t_meas_lo = t_full_lo + t_span * trim_pct
            t_meas_hi = t_full_hi - t_span * trim_pct
            body_mask = (ts_arr >= t_meas_lo) & (ts_arr <= t_meas_hi)
            ts_body, ds_body = ts_arr[body_mask], ds_arr[body_mask]

            # ── 강건 polyfit으로 "이상적인 평균 비드 경로" 구하기 ──
            # 평판: 1차(직선), 배관: 2차(부드러운 곡선)
            # IRLS Huber 가중 → 국지적 wobble은 무시하고 본체 평균을 따라감
            ref_degree = 2 if is_pipe else 1
            if len(ts_body) >= ref_degree + 1:
                ref_coeffs = _robust_polyfit(ts_body, ds_body, degree=ref_degree, n_iter=3)
            else:
                ref_coeffs = None
            if ref_coeffs is None:
                # 폴백: 시점-끝점 직선
                if t_full_hi != t_full_lo:
                    slope0 = (float(ds_arr[-1]) - float(ds_arr[0])) / (t_full_hi - t_full_lo)
                else:
                    slope0 = 0.0
                ref_coeffs = np.array([slope0, float(ds_arr[0]) - slope0 * t_full_lo])
            ref_poly = np.poly1d(ref_coeffs)
            ref_poly_deriv = np.polyder(ref_poly)

            # ── 폭 측정: 본체 구간을 따라 reference curve의 LOCAL TANGENT 에 수직 방향으로 측정 ──
            # 휜 비드도 정확하게 잴 수 있고, 동일 거리 간격 N개 샘플 → IQR 변동
            N_WIDTH_SAMPLES = 30
            sample_ts_meas = np.linspace(t_meas_lo, t_meas_hi, N_WIDTH_SAMPLES)
            half_window = (t_meas_hi - t_meas_lo) / N_WIDTH_SAMPLES / 2.0 * 1.6  # 안전계수 ↑

            # ── 폴리곤 변을 미세 보간 ──
            # Roboflow 폴리곤 꼭짓점은 희박/불규칙이라 슬라이스마다 잡히는
            # 점 수가 들쭉날쭉 → 측정값 분포가 양극화되고 IQR 이 부풀려짐.
            # 변을 ~3px 간격으로 보간하면 모든 슬라이스가 위·아래 양변 점을
            # 충분히 잡아 일관된 폭이 측정된다.
            dense_pts = _densify_polygon(pts.astype(np.float64), max_seg_len_px=3.0)
            pts_t_local = (dense_pts[:, 0] - ox) * ux + (dense_pts[:, 1] - oy) * uy
            pts_d_local = (dense_pts[:, 0] - ox) * nx + (dense_pts[:, 1] - oy) * ny

            # widths_data: (t_s, w_corr_pix) 페어 — 슬라이스별 폭 측정값.
            # 폭 변동 IQR + 최대 편차 슬라이스 위치 계산에 모두 사용.
            widths_data: list[tuple[float, float]] = []
            for t_s in sample_ts_meas:
                d_ref_local = float(ref_poly(t_s))
                slope = float(ref_poly_deriv(t_s))
                norm = math.sqrt(1.0 + slope * slope)
                tan_t, tan_d = 1.0 / norm, slope / norm           # local 탄젠트
                perp_t, perp_d = -slope / norm, 1.0 / norm        # local 법선
                rel_t = pts_t_local - t_s
                rel_d = pts_d_local - d_ref_local
                along = rel_t * tan_t + rel_d * tan_d
                perp  = rel_t * perp_t + rel_d * perp_d
                mask = np.abs(along) <= half_window
                if mask.sum() >= 2:
                    w_pix_local = float(np.max(perp[mask]) - np.min(perp[mask]))
                    if w_pix_local > 0:
                        w_corr = _foreshorten_correct(w_pix_local, float(t_s))
                        widths_data.append((float(t_s), w_corr))

            widths_pix = [w for (_, w) in widths_data]

            # ── 폭 변동 = IQR(P75 - P25) ──
            # bead_widths_mm 의 max/min 자리에 P75/P25 를 채워 넣어
            # welding_calculator 의 (max - min) 공식이 자연스럽게 IQR 이 되게 함
            if len(widths_pix) >= 4:
                arr = np.array(widths_pix, dtype=np.float64)
                p25, p50, p75 = np.percentile(arr, [25, 50, 75])
                bead_widths_mm.append(round(float(p25 / ppm), 2))
                bead_widths_mm.append(round(float(p50 / ppm), 2))
                bead_widths_mm.append(round(float(p75 / ppm), 2))
            elif widths_pix:
                for w_pix in widths_pix:
                    bead_widths_mm.append(round(float(w_pix / ppm), 2))

            # ── 직진도: 본체 구간 내 (raw 중심선 - reference curve) 최대 편차 ──
            ref_d_body = ref_poly(ts_body)
            dev_body = np.abs(ds_body - ref_d_body)
            if dev_body.size > 0:
                max_dev_pix = float(dev_body.max())
                max_local_idx = int(dev_body.argmax())
                t_worst = float(ts_body[max_local_idx])
                d_worst = float(ds_body[max_local_idx])
            else:
                # 폴백: 전체 구간
                ref_d_full = ref_poly(ts_arr)
                dev_full = np.abs(ds_arr - ref_d_full)
                max_dev_pix = float(dev_full.max())
                idx = int(dev_full.argmax())
                t_worst, d_worst = float(ts_arr[idx]), float(ds_arr[idx])

            worst_x = ox + t_worst * ux + d_worst * nx
            worst_y = oy + t_worst * uy + d_worst * ny
            straightness_variances.append(round(float(max_dev_pix / ppm), 2))

            # ── 폭 최대 편차 슬라이스 위치 (시각화용 보라색 마커) ──
            # 중앙값(median) 폭 대비 가장 많이 벗어난 슬라이스의 t 좌표를 찾고,
            # 그 t 위치의 reference curve 점에 마커를 찍는다.
            # (실제 비드 형상 그래프에서 사용자가 시각적으로 보는 "폭이 가장
            # 불균일한 지점"을 히트맵 위에 직접 표시 → 직진도 빨간 점과 분리)
            worst_width_x_pct = None
            worst_width_y_pct = None
            worst_width_dev_mm = 0.0
            if len(widths_data) >= 2:
                w_arr = np.array([w for (_, w) in widths_data], dtype=np.float64)
                t_arr_w = np.array([t for (t, _) in widths_data], dtype=np.float64)
                median_w_pix = float(np.median(w_arr))
                w_dev_pix = np.abs(w_arr - median_w_pix)
                idx_w = int(w_dev_pix.argmax())
                worst_t_w = float(t_arr_w[idx_w])
                worst_dev_pix_w = float(w_dev_pix[idx_w])
                # mm 변환 (편차는 폭의 절반만큼 한쪽으로 벌어진 것이므로 그대로 폭 차이로 취급)
                worst_width_dev_mm = round(worst_dev_pix_w / ppm, 2)
                # 마커 위치: 그 t 의 reference curve 점 (실제 비드 중심을 따라가는 곡선 위)
                worst_d_w = float(ref_poly(worst_t_w))
                worst_x_w = ox + worst_t_w * ux + worst_d_w * nx
                worst_y_w = oy + worst_t_w * uy + worst_d_w * ny
                worst_width_x_pct = round(float(worst_x_w / image_width  * 100), 2)
                worst_width_y_pct = round(float(worst_y_w / image_height * 100), 2)

            # ── 시각화 데이터 ──
            # ① 실제 비드 중심선 (raw, 평활화 없음) — 본체 구간만 (트림된 부분 제외)
            actual_centerline_pct = []
            for t_v, d_v in zip(ts_body, ds_body):
                gx = ox + float(t_v) * ux + float(d_v) * nx
                gy = oy + float(t_v) * uy + float(d_v) * ny
                actual_centerline_pct.append({
                    "x_pct": round(float(gx / image_width  * 100), 2),
                    "y_pct": round(float(gy / image_height * 100), 2),
                })

            # ② Reference curve (평균 기준선) — 본체 구간 20점 샘플
            #    평판이면 직선, 배관이면 부드러운 곡선
            reference_curve_pct = []
            sample_ts_vis = np.linspace(t_meas_lo, t_meas_hi, 20)
            for t_s in sample_ts_vis:
                d_s = float(ref_poly(t_s))
                gx = ox + t_s * ux + d_s * nx
                gy = oy + t_s * uy + d_s * ny
                reference_curve_pct.append({
                    "x_pct": round(float(gx / image_width  * 100), 2),
                    "y_pct": round(float(gy / image_height * 100), 2),
                })

            # ③ Roboflow 검출 비드 폴리곤 (반투명 오버레이)
            bead_polygon_pct = [
                {"x_pct": round(float(p[0] / image_width  * 100), 2),
                 "y_pct": round(float(p[1] / image_height * 100), 2)}
                for p in pts
            ]

            # 시점/끝점 (히트맵 작은 원) — 본체 구간의 첫·마지막 reference curve 점
            d_start_ref = float(ref_poly(t_meas_lo))
            d_end_ref   = float(ref_poly(t_meas_hi))
            p_start_x = ox + t_meas_lo * ux + d_start_ref * nx
            p_start_y = oy + t_meas_lo * uy + d_start_ref * ny
            p_end_x   = ox + t_meas_hi * ux + d_end_ref   * nx
            p_end_y   = oy + t_meas_hi * uy + d_end_ref   * ny

            line_entry = {
                "start_x_pct": round(float(p_start_x / image_width  * 100), 2),
                "start_y_pct": round(float(p_start_y / image_height * 100), 2),
                "end_x_pct":   round(float(p_end_x   / image_width  * 100), 2),
                "end_y_pct":   round(float(p_end_y   / image_height * 100), 2),
                "worst_x_pct": round(float(worst_x   / image_width  * 100), 2),
                "worst_y_pct": round(float(worst_y   / image_height * 100), 2),
                "deviation_mm": round(float(max_dev_pix / ppm), 2),
                # 폭 최대 편차 슬라이스 위치 (보라색 마커) — 없으면 None
                "worst_width_x_pct": worst_width_x_pct,
                "worst_width_y_pct": worst_width_y_pct,
                "worst_width_dev_mm": worst_width_dev_mm,
                "is_curve": bool(is_pipe),
                "trim_pct": float(trim_pct),
                # ① 실제 비드 중심선 (구불구불, 본체 구간)
                "centerline_points_pct": actual_centerline_pct,
                # ② Reference curve (평균 기준선) — 평판=직선, 배관=곡선
                "reference_curve_pct": reference_curve_pct,
                # 구버전 호환: curve_points_pct 도 같은 reference_curve 로 채움
                "curve_points_pct": reference_curve_pct,
                # ③ Roboflow 검출 폴리곤
                "bead_polygon_pct": bead_polygon_pct,
            }
            straightness_lines.append(line_entry)

        elif cls_name != 'Reference_Marker':
            # 결함 크기 및 위치 추출 (모든 인스턴스 그대로 보존)
            if 'width' in pred and 'height' in pred:
                defect_w = pred['width'] / ppm
                defect_h = pred['height'] / ppm
                max_size_mm = max(defect_w, defect_h)
                defects_info.append({
                    "class": cls_name,
                    "size_mm": round(max_size_mm, 2),
                    "x_percent": round((pred.get('x', 0) / image_width) * 100, 1),
                    "y_percent": round((pred.get('y', 0) / image_height) * 100, 1),
                    "confidence": round(pred.get('confidence', 0) * 100),
                })

    if not bead_widths_mm:
        return {"status": "error", "message": "사진에서 용접 비드(Weld_Bead)를 인식하지 못했습니다."}

    bead_polygon_pct = straightness_lines[0].get("bead_polygon_pct") if straightness_lines else None
    if has_laser and image_bytes:
        laser_result = analyze_laser_grid(
            image_bytes=image_bytes,
            ppm=ppm,
            laser_angle_deg=laser_angle_deg,
            bead_polygon_pct=bead_polygon_pct,
        )
    else:
        laser_result = None

    return {
        "status": "success",
        "ppm": round(float(ppm), 2),
        "bead_width_max": round(float(max(bead_widths_mm)), 2),
        "bead_width_min": round(float(min(bead_widths_mm)), 2),
        "straightness_variance": round(float(max(straightness_variances)), 2) if straightness_variances else 0.0,
        "straightness_lines": straightness_lines,
        "defects_info": defects_info,
        "is_pipe": bool(is_pipe),
        "laser_analysis": laser_result,
    }

def _variance_to_score(variance_mm: float) -> int:
    """매 0.5mm당 -5점 감점 (최저 0점). 0mm=100, 0.5mm=95, 1mm=90, ..., 10mm=0."""
    if variance_mm < 0:
        variance_mm = 0
    steps = int(variance_mm / 0.5)  # 0.5mm 구간 수 (내림)
    return max(0, 100 - steps * 5)


def _dedup_defects(defect_list):
    """동일 결함 중복 제거. 키: (class, round(x_percent), round(y_percent), round(size_mm))"""
    seen = set()
    unique = []
    for d in defect_list:
        key = (
            d.get('class', ''),
            round(d.get('x_percent', 0)),
            round(d.get('y_percent', 0)),
            round(d.get('size_mm', 0)),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(d)
    return unique


def _calculate_fillet_score(fillet_result: dict) -> dict:
    """
    필릿 용접 100점 만점 채점.
    가중치: 각장 균일성 35% | 목두께 달성률 25% | 부등각장 20% | 볼록도 20%
    """
    ul   = fillet_result.get("unequalLeg") or {}
    z1   = ul.get("z1") or fillet_result.get("equalLeg") or 0
    z2   = ul.get("z2") or fillet_result.get("equalLeg") or 0
    diff = ul.get("difference") or 0

    # 각장 균일성: Z1-Z2 차이, 0.5mm 당 -5점
    leg_diff_mm = abs(float(z1) - float(z2)) if (z1 and z2) else float(diff)
    leg_score   = max(0, 100 - int(leg_diff_mm / 0.5) * 5)

    # 목두께 달성률: 실제/이론 비율 (85~110% = 100점)
    theoretical = float(fillet_result.get("theoreticalThroat") or 0)
    actual      = float(fillet_result.get("actualThroat") or 0)
    if theoretical > 0 and actual > 0:
        ratio = actual / theoretical
        if 0.85 <= ratio <= 1.10:
            throat_score = 100
        elif ratio < 0.85:
            throat_score = max(0, int(100 - (0.85 - ratio) * 300))
        else:
            throat_score = max(0, int(100 - (ratio - 1.10) * 200))
    else:
        throat_score = 70  # 측정 불가

    # 부등각장: 차이 0.5mm 당 -10점
    is_unequal   = ul.get("isUnequal", False)
    unequal_score = max(0, 100 - int(float(diff) / 0.5) * 10) if is_unequal else 100

    # 볼록도: |value_mm| 0.5mm 당 -5점 (0에 가까울수록 우수)
    convex    = fillet_result.get("convexity") or {}
    convex_mm = abs(float(convex.get("value_mm") or 0))
    convex_score = max(0, 100 - int(convex_mm / 0.5) * 5)

    total = int(round(
        0.35 * leg_score + 0.25 * throat_score + 0.20 * unequal_score + 0.20 * convex_score
    ))
    return {
        "leg_score":      leg_score,
        "throat_score":   throat_score,
        "unequal_score":  unequal_score,
        "convex_score":   convex_score,
        "fillet_total_score": total,
    }


def _defect_penalty(combined_defects):
    """
    결함 감점 계산 (Roboflow confidence 20% 기준, 개수별 누적 감점).

    감점 기준표 (AWS D1.1 / NCS 용접 평가 기준 참고):
    ┌─────────────────────────────┬──────────────────────────────────┐
    │ 결함 종류                   │ 감점 (개당)                      │
    ├─────────────────────────────┼──────────────────────────────────┤
    │ 균열 (Crack)                │ -100점, 즉시 불합격              │
    │ 용입/용착 불량              │ -20점                            │
    │ 기공 (Porosity)             │ -10점 (크기 2mm 초과 시 -15점)  │
    │ 언더컷 (Undercut)           │ -10점                            │
    │ 오버랩 (Overlap)            │ -10점                            │
    │ 아크 스트라이크             │ -10점                            │
    │ 여고 과다 (Excessive Reinf.)│ -10점                            │
    │ 스패터 (Spatter)            │ -5점 (3개 초과 시 누적 -5점 추가)│
    └─────────────────────────────┴──────────────────────────────────┘
    """
    penalty = 0
    defect_list_ko = []
    is_critical_fail = False
    spatter_count = 0

    for d in combined_defects:
        d_type   = d.get('class', '')
        d_size   = d.get('size_mm', 0)
        src      = d.get('source', 'front')
        face_tag = "[이면] " if src == 'back' else ""

        if d_type == 'Crack':
            penalty += 100
            defect_list_ko.append(f"{face_tag}균열({d_size}mm, 즉시 불합격)")
            is_critical_fail = True
        elif d_type in ['Lack of Fusion', 'Incomplete Penetration']:
            penalty += 20
            defect_list_ko.append(f"{face_tag}용입/용착 불량({d_size}mm, -20점)")
        elif d_type == 'Porosity':
            pts = 15 if d_size > 2.0 else 10
            penalty += pts
            defect_list_ko.append(f"{face_tag}기공({d_size}mm, -{pts}점)")
        elif d_type == 'Undercut':
            penalty += 10
            defect_list_ko.append(f"{face_tag}언더컷({d_size}mm, -10점)")
        elif d_type == 'Overlap':
            penalty += 10
            defect_list_ko.append(f"{face_tag}오버랩({d_size}mm, -10점)")
        elif d_type == 'Arc Strike':
            penalty += 10
            defect_list_ko.append(f"{face_tag}아크 스트라이크(-10점)")
        elif d_type == 'Spatter':
            spatter_count += 1
            base_pts = 5
            if spatter_count > 3:
                base_pts += 5  # 3개 초과분은 누적 강화
            penalty += base_pts
            defect_list_ko.append(f"{face_tag}스패터(-{base_pts}점, 누적 {spatter_count}개)")
        elif d_type == 'Excessive Reinforcement':
            penalty += 10
            defect_list_ko.append(f"{face_tag}여고 과다({d_size}mm, -10점)")

    return penalty, defect_list_ko, is_critical_fail


def calculate_bead_scores_for_photo(vision_data):
    """
    사진 1장에 대한 비드 점수 (폭 + 직진도). 사진별 탭 표시 + 평균 계산용.
    vision_data 가 없거나 status != success 이면 None 반환.
    """
    if not vision_data or vision_data.get('status') != 'success':
        return None
    width_var = max(
        0.0,
        vision_data.get('bead_width_max', 0) - vision_data.get('bead_width_min', 0),
    )
    width_score = _variance_to_score(width_var)
    st_var = vision_data.get('straightness_variance', 0) or 0
    st_score = _variance_to_score(st_var)
    bead_total = int(round((width_score + st_score) / 2))
    return {
        "width_score": width_score,
        "width_variance": round(width_var, 2),
        "straightness_score": st_score,
        "straightness_variance": round(st_var, 2),
        "bead_total_score": bead_total,
    }


def calculate_weld_score(
    vision_data,
    has_side_photo=False,
    side_vision_data=None,
    back_vision_data=None,
    is_fillet: bool = False,
    fillet_result: dict | None = None,
):
    try:
        # ── 공통: 결함 목록 수집 및 감점 계산 ────────────────────────────
        front_defects = list(vision_data.get('defects_info', []))
        back_defects  = list(back_vision_data.get('defects_info', [])) if back_vision_data else []
        for d in front_defects: d.setdefault('source', 'front')
        for d in back_defects:  d.setdefault('source', 'back')
        combined_defects = _dedup_defects(front_defects + back_defects)
        penalty, defect_list_ko, is_critical_fail = _defect_penalty(combined_defects)

        # ── 필릿 용접 채점 분기 ───────────────────────────────────────────
        if is_fillet and fillet_result and fillet_result.get("status") == "success":
            fillet_scores = _calculate_fillet_score(fillet_result)
            fillet_total  = fillet_scores["fillet_total_score"]
            final_score   = max(0, min(100, fillet_total - penalty))
            is_pass       = "FAIL" if (is_critical_fail or final_score < 70) else "PASS"

            # 사진별 비드 점수도 계산(탭 표시용)
            front_bead = calculate_bead_scores_for_photo(vision_data) or {}
            return {
                "final_score":   final_score,
                "is_pass":       is_pass,
                "bead_total_score":   fillet_total,
                "width_score":        fillet_scores["leg_score"],
                "width_variance":     0.0,
                "straightness_score": fillet_scores["throat_score"],
                "straightness_variance": 0.0,
                "height_score":       fillet_scores["unequal_score"],
                "height_variance":    0.0,
                "detected_defects":   defect_list_ko,
                "fillet_scores":      fillet_scores,
                "per_photo_bead": {
                    "front": front_bead,
                    "side":  None,
                    "back":  None,
                },
            }

        # ── 맞대기(일반) 용접 채점 ─────────────────────────────────────────
        # ── 1. 사진별 비드 점수 (정면 / 측면 / 이면 각각 독립 계산) ────────
        front_bead = calculate_bead_scores_for_photo(vision_data) or {
            "width_score": 0,
            "width_variance": 0.0,
            "straightness_score": 0,
            "straightness_variance": 0.0,
            "bead_total_score": 0,
        }
        side_bead = calculate_bead_scores_for_photo(side_vision_data) if has_side_photo else None
        back_bead = calculate_bead_scores_for_photo(back_vision_data) if back_vision_data else None

        # ── 2. 종합 비드 점수 = 사진별 점수의 평균 ──────────────────────
        photos_scored = [b for b in (front_bead, side_bead, back_bead) if b is not None and b.get("bead_total_score") is not None]
        if not photos_scored:
            photos_scored = [front_bead]  # 안전망

        bead_total_score = int(round(sum(b["bead_total_score"] for b in photos_scored) / len(photos_scored)))
        avg_width_score = int(round(sum(b["width_score"] for b in photos_scored) / len(photos_scored)))
        avg_st_score    = int(round(sum(b["straightness_score"] for b in photos_scored) / len(photos_scored)))
        avg_width_var   = round(sum(b["width_variance"] for b in photos_scored) / len(photos_scored), 2)
        avg_st_var      = round(sum(b["straightness_variance"] for b in photos_scored) / len(photos_scored), 2)

        # 측면 사진의 비드 폭 변동을 "비드 높이 변동"으로 해석 (관행) — 백워드 호환용
        height_score = None
        height_variance = 0.0
        if side_bead is not None:
            height_variance = side_bead["width_variance"]
            height_score = side_bead["width_score"]

        # ── 3. 결함 감점 (공통 처리에서 이미 계산됨) ─────────────────────
        final_score = max(0, min(100, bead_total_score - penalty))
        is_pass = "FAIL" if (is_critical_fail or final_score < 70) else "PASS"

        return {
            "final_score": final_score,
            "is_pass": is_pass,
            # 종합 (모든 사진 평균)
            "bead_total_score": bead_total_score,
            "width_score": avg_width_score,
            "width_variance": avg_width_var,
            "straightness_score": avg_st_score,
            "straightness_variance": avg_st_var,
            "height_score": height_score,
            "height_variance": round(height_variance, 2),
            "detected_defects": defect_list_ko,
            # 사진별 — 탭 표시용
            "per_photo_bead": {
                "front": front_bead,
                "side":  side_bead,
                "back":  back_bead,
            },
        }
    except Exception as e:
        import traceback
        print(f"\033[91m[calculate_weld_score] 예외: {e}\033[0m")
        traceback.print_exc()
        return {
            "final_score": 0,
            "is_pass": "FAIL",
            "bead_total_score": 0,
            "width_score": 0,
            "width_variance": 0.0,
            "straightness_score": 0,
            "straightness_variance": 0.0,
            "height_score": None,
            "height_variance": 0.0,
            "detected_defects": [],
            "per_photo_bead": {"front": None, "side": None, "back": None},
        }

import os
import math
import base64
import httpx
import numpy as np
from typing import Optional
from fastapi import FastAPI, UploadFile, Form, File
from fastapi.responses import JSONResponse
from openai import AsyncOpenAI
from anthropic import AsyncAnthropic

from welding_calculator import calculate_weld_score
from gpt_advisor import get_expert_advice
from vision_processor import analyze_bead_dimensions

app = FastAPI(title="Welding AI Master Pipeline")

# ==========================================
# [설정] 환경 변수
# ==========================================
ROBOFLOW_API_KEY  = os.environ.get("ROBOFLOW_API_KEY", "")
# ROBOFLOW_MODEL_ID는 "project/version" 형태 (예: ai_welding_diagnosis/1)
# URL: https://detect.roboflow.com/{ROBOFLOW_MODEL}?api_key=...
ROBOFLOW_MODEL    = os.environ.get("ROBOFLOW_MODEL_ID", "weld-defect/3")
REAL_MARKER_SIZE_MM = 30.0

# 시작 시 어떤 모델/마커 크기로 동작 중인지 콘솔에 명시
# (env var 를 바꿔도 워크플로 재시작 전엔 옛 값이 그대로 남으므로 헷갈림 방지)
print(f"[Init] Roboflow model = '{ROBOFLOW_MODEL}' | marker = {REAL_MARKER_SIZE_MM}mm | "
      f"API key {'설정됨' if ROBOFLOW_API_KEY else '⚠️ 미설정'}")

openai_client    = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
anthropic_client = AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

# ==========================================
# [공통] Roboflow 원본 클래스명 → 한국어 매핑
# (대소문자·띄어쓰기 포함 원본 그대로 사용)
# ==========================================
_CLASS_TO_KO = {
    "Crack":                   "균열 (Crack)",
    "Porosity":                "기공 (Porosity)",
    "Undercut":                "언더컷 (Undercut)",
    "Overlap":                 "오버랩 (Overlap)",
    "Spatter":                 "스패터 (Spatter)",
    "Arc Strike":              "아크 스트라이크 (Arc Strike)",
    "Lack of Fusion":          "용착 불량 (Lack of Fusion)",
    "Incomplete Penetration":  "용입 불량 (Incomplete Penetration)",
    "Excessive Reinforcement": "여고 과다 (Excessive Reinforcement)",
}

# 결함평가 표에 항상 나열되는 9가지 종류 (감지 안 되면 "없음/0점"으로 표시)
_DEFECT_TEMPLATES = [
    ("균열 (Crack)",                            "불허",     "불합격"),
    ("기공 (Porosity)",                         "불허",     "불합격"),
    ("언더컷 (Undercut)",                       "0.5mm",   "불합격"),
    ("오버랩 (Overlap)",                        "불허",     "불합격"),
    ("스패터 (Spatter)",                        "경미허용", "경고"),
    ("아크 스트라이크 (Arc Strike)",              "불허",     "불합격"),
    ("용착 불량 (Lack of Fusion)",              "불허",     "불합격"),
    ("용입 불량 (Incomplete Penetration)",      "불허",     "불합격"),
    ("여고 과다 (Excessive Reinforcement)",     "불허",     "불합격"),
]

def map_class_to_korean(cls: str) -> str:
    return _CLASS_TO_KO.get(cls, cls)

# ==========================================
# [모듈 1] 픽셀 → mm 변환 (레거시 ArUco)
# ==========================================
def calculate_pixel_to_mm_ratio(marker_polygon):
    if not marker_polygon:
        return None
    x_coords = [p['x'] for p in marker_polygon]
    pixel_width = max(x_coords) - min(x_coords)
    return REAL_MARKER_SIZE_MM / pixel_width if pixel_width > 0 else None

def analyze_bead_quality(polygon, mm_ratio, is_pipe=False):
    if not polygon or len(polygon) < 5:
        return {"width_variation_mm": 0, "max_width_mm": 0, "min_width_mm": 0, "straightness_error_mm": 0}

    xs = np.array([p['x'] for p in polygon])
    ys = np.array([p['y'] for p in polygon])

    is_horizontal = (np.max(xs) - np.min(xs)) > (np.max(ys) - np.min(ys))
    indep = xs if is_horizontal else ys
    dep   = ys if is_horizontal else xs

    degree = 2 if is_pipe else 1
    try:
        coeffs    = np.polyfit(indep, dep, degree)
        poly_fn   = np.poly1d(coeffs)
        residuals = np.abs(dep - poly_fn(indep))
        straightness_error_mm = round(float(np.max(residuals)) * mm_ratio, 2)
    except Exception as e:
        print(f"Curve fitting error: {e}")
        straightness_error_mm = 0.0

    segments  = 10
    min_val, max_val = np.min(indep), np.max(indep)
    step   = (max_val - min_val) / segments
    widths = []
    for i in range(segments):
        mask = (indep >= min_val + i * step) & (indep <= min_val + (i + 1) * step)
        seg  = dep[mask]
        if len(seg) > 0:
            widths.append(float(np.max(seg) - np.min(seg)))

    if not widths:
        return {"width_variation_mm": 0, "max_width_mm": 0, "min_width_mm": 0,
                "straightness_error_mm": straightness_error_mm}

    max_width_mm       = round(max(widths) * mm_ratio, 2)
    min_width_mm       = round(min(widths) * mm_ratio, 2)
    width_variation_mm = round(max_width_mm - min_width_mm, 2)

    return {
        "width_variation_mm":    width_variation_mm,
        "max_width_mm":          max_width_mm,
        "min_width_mm":          min_width_mm,
        "straightness_error_mm": straightness_error_mm,
        "is_pipe_evaluated":     is_pipe,
    }

def process_vision_data(roboflow_json, is_pipe=False):
    predictions       = roboflow_json.get("predictions", [])
    marker_polygon    = None
    weld_bead_polygon = None
    defects = []

    for pred in predictions:
        cls     = pred['class']
        polygon = pred.get('points', [])
        if cls == "Reference_Marker":
            marker_polygon = polygon
        elif cls == "Weld_Bead":
            weld_bead_polygon = polygon
        else:
            defects.append({"type": cls, "polygon": polygon, "confidence": pred.get('confidence', 0)})

    if not marker_polygon:
        raise ValueError("사진에서 30mm ArUco 마커를 찾을 수 없습니다.")

    mm_ratio = calculate_pixel_to_mm_ratio(marker_polygon)

    analyzed_defects = []
    for d in defects:
        xs = [p['x'] for p in d['polygon']]
        ys = [p['y'] for p in d['polygon']]
        if xs and ys:
            w_mm = (max(xs) - min(xs)) * mm_ratio
            h_mm = (max(ys) - min(ys)) * mm_ratio
            max_len_mm = round(math.sqrt(w_mm**2 + h_mm**2), 2)
        else:
            max_len_mm = 0.0
        analyzed_defects.append({"type": d['type'], "size_mm": max_len_mm})

    bead_quality = analyze_bead_quality(weld_bead_polygon, mm_ratio, is_pipe)
    return {"defects": analyzed_defects, "bead_quality": bead_quality}

# ==========================================
# [모듈 2] LLM 명장 리포트 (마크다운)
# ==========================================
async def generate_expert_report(process: str, vision_data: dict, ai_model: str, is_pipe: bool = False, language_name: str = "Korean"):
    defects = vision_data.get("defects", [])
    bead    = vision_data.get("bead_quality", {})

    defects_str = "\n".join([f"- {d.get('type', d.get('name',''))}: max length ~{d.get('size_mm', 0)}mm"
                              for d in defects])
    if not defects_str:
        defects_str = "- No notable defects (good)"

    pipe_ctx = "Note: this data is precisely calculated reflecting the curvature of a round pipe." if is_pipe else ""

    prompt = f"""
You are a strict but skilled master welder with 20 years of experience in Korea.
The following is quantitative data measured by an AI vision system for a {process} welding result.
{pipe_ctx}

[Bead quality measurement data]
- Max bead width: {bead.get('max_width_mm')}mm
- Min bead width: {bead.get('min_width_mm')}mm
- Bead width variation: {bead.get('width_variation_mm')}mm
- Straightness error: {bead.get('straightness_error_mm')}mm

[Detected external defects]
{defects_str}

[Instructions]
1. If bead width variation is 2mm+ or straightness error is large, travel speed or posture is unstable.
   Cite the specific numbers and sharply point out the cause.
2. If external defects are found, analyze the cause as well.
3. Give practical advice on how the trainee can stabilize their hand and maintain steady travel speed
   (grip, posture, etc.) on the next attempt.
4. Write in markdown with a warm but strict tone, as if a site foreman is mentoring directly.

VERY IMPORTANT: Write the ENTIRE response in {language_name}. Every word, including section
headers and technical terms, must be in {language_name}. Do not output any Korean text unless
{language_name} is Korean.
"""

    if ai_model.lower() == "claude":
        resp = await anthropic_client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1000,
            temperature=0.7,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.content[0].text
    else:
        resp = await openai_client.chat.completions.create(
            model="gpt-4o",
            max_tokens=1000,
            temperature=0.7,
            messages=[
                {"role": "system", "content": f"You are a master welder with 20 years of experience. Always respond in {language_name}."},
                {"role": "user", "content": prompt},
            ],
        )
        return resp.choices[0].message.content

# ==========================================
# [헬퍼] beadAnalysis 구조 생성
# ==========================================
def _grade_width(mm: float):
    if mm < 1.0: return 95, "우수"
    if mm < 2.0: return 83, "양호"
    if mm < 3.0: return 68, "주의"
    return 50, "불량"

def _grade_straightness(mm: float):
    if mm < 0.1: return 95, "우수"
    if mm < 1.0: return 83, "양호"
    if mm < 2.0: return 68, "주의"
    return 50, "불량"

_SHAPE_EVAL_SCORE = {"우수": 95, "양호": 83, "주의": 68, "불량": 50}

def build_bead_analysis(bead_quality_mm: dict, weld_score: dict) -> dict:
    width_var = float(bead_quality_mm.get("width_variation_mm") or weld_score.get("width_variance") or 2.0)
    max_w     = bead_quality_mm.get("max_width_mm") or 0
    min_w     = bead_quality_mm.get("min_width_mm") or 0
    straight  = bead_quality_mm.get("straightness_error_mm", None)

    w_score, w_result = _grade_width(width_var)
    width_val = f"최대{max_w}mm/최소{min_w}mm" if max_w else f"편차{width_var}mm(추정)"

    if straight is not None:
        s_score, s_result = _grade_straightness(float(straight))
        straight_val = f"±{straight}mm"
    else:
        s_score, s_result = 70, "주의"
        straight_val = "측정불가(추정)"

    shape_eval = weld_score.get("shape_eval", "양호")
    p_score    = _SHAPE_EVAL_SCORE.get(shape_eval, 83)

    total = round((w_score + 75 + s_score + p_score) / 4)

    return {
        "totalScore":      total,
        "width":           {"value": width_val,          "score": w_score, "result": w_result},
        "height":          {"value": "측정불가(추정)",  "score": 75,      "result": "주의"},
        "straightness":    {"value": straight_val,        "score": s_score, "result": s_result},
        "pitchUniformity": {"value": shape_eval,          "score": p_score, "result": shape_eval},
    }

def build_defects_array(raw_defects: list, confidence_map: dict) -> list:
    detected_ko = {map_class_to_korean(d.get("type", "")): confidence_map.get(map_class_to_korean(d.get("type", "")), 75)
                   for d in raw_defects}
    result = []
    for name, limit, res_detected in _DEFECT_TEMPLATES:
        if name in detected_ko:
            conf     = detected_ko[name]
            severity = "심각" if conf >= 80 else "보통" if conf >= 60 else "경미"
            result.append({"name": name, "detected": True, "severity": severity,
                           "confidence": conf, "standard": "선급",
                           "measured": "탐지됨", "limit": limit, "result": res_detected})
        else:
            result.append({"name": name, "detected": False, "severity": "없음",
                           "confidence": 0, "standard": "선급",
                           "measured": "없음", "limit": limit, "result": "합격"})
    return result

def _extract_list(advice: dict, keys: list) -> list:
    for k in keys:
        v = advice.get(k)
        if isinstance(v, list) and v:
            return [str(i) for i in v]
        if isinstance(v, str) and v:
            return [v]
    for v in advice.values():
        if isinstance(v, list) and v:
            return [str(i) for i in v]
    return ["전문가 분석이 완료되었습니다. 상세 리포트를 확인하세요."]

def _extract_str(advice: dict, keys: list) -> str:
    for k in keys:
        v = advice.get(k)
        if isinstance(v, str) and v:
            return v
    for v in advice.values():
        if isinstance(v, str) and len(v) > 20:
            return v
    return ""


def _build_fallback_report(weld_data: dict, context_meta: dict, has_side_photo: bool) -> str:
    """GPT 호출 실패 시 측정값 기반 결정론적 종합 리포트 생성.
    UI 파서가 인식하는 '## N. 제목' 5섹션 마크다운 포맷을 그대로 따른다.
    """
    final_score = weld_data.get("final_score", 0)
    is_pass = weld_data.get("is_pass", "FAIL")
    width_var = weld_data.get("width_variance", 0)
    straight_var = weld_data.get("straightness_variance", 0)
    bead_total = weld_data.get("bead_total_score", 0)
    width_score = weld_data.get("width_score", 0)
    straight_score = weld_data.get("straightness_score", 0)
    height_var = weld_data.get("height_variance")
    height_score = weld_data.get("height_score")
    detected = weld_data.get("detected_defects", []) or []
    process = context_meta.get("process", "?")
    posture = context_meta.get("posture", "?")
    material = context_meta.get("material", "?")

    height_block = ""
    if has_side_photo and height_var is not None:
        height_block = f"\n- 비드 높이 편차: **{height_var}mm** ({height_score}점)"

    defect_block = (
        "- 검출된 결함: " + ", ".join(detected) if detected else "- 검출된 결함 없음"
    )

    sec1 = (
        f"## 1. 이번 용접 진단\n"
        f"- 최종 점수: **{final_score}점** / 판정: **{is_pass}**\n"
        f"- 비드 폭 편차: **{width_var}mm** ({width_score}점)\n"
        f"- 직진도 이탈: **{straight_var}mm** ({straight_score}점)"
        f"{height_block}\n"
        f"- 비드 종합 점수: **{bead_total}점**\n"
        f"{defect_block}"
    )
    sec2 = (
        "## 2. 학습 추세 분석\n"
        "이번 진단 데이터를 기반으로 향후 추세를 누적해 나갑니다. "
        "회차가 쌓일수록 점수 변화·결함 패턴을 더 정밀하게 비교할 수 있습니다."
    )
    sec3 = (
        "## 3. 반복 결함 근본 원인\n"
        + ("이번 진단에서 검출된 결함이 누적될 경우, 전류·운봉 속도·자세 안정성 측면에서 "
           "공통 원인을 점검하시기 바랍니다."
           if detected else
           "검출된 결함이 없습니다. 현재 작업 조건을 유지하시고, 다음 회차에 측면 사진을 함께 "
           "올리시면 비드 높이까지 종합적으로 평가됩니다.")
    )
    sec4 = (
        "## 4. 우선순위 개선 액션\n"
        f"1순위: {'폭 균일성 개선 — 위빙 폭/주기를 일정하게' if width_score < 80 else '직진도 유지 — 토치 진행 라인 유지'}\n"
        f"2순위: {'직진도 개선 — 가이드 사용 또는 시선 고정' if straight_score < 80 else '결함 발생 변수 점검'}\n"
        f"3순위: {'측면 사진 함께 업로드해 비드 높이까지 평가' if not has_side_photo else '검출 결함의 재발 방지 점검'}"
    )
    sec5 = (
        f"## 5. 다음 연습 가이드\n"
        f"- 공정 **{process}** / 자세 **{posture}** / 모재 **{material}** 조건을 유지\n"
        "- 동일 조건에서 3회 이상 반복 촬영해 추세를 확보\n"
        "- 측면 사진을 함께 업로드해 비드 높이 평가까지 받는 것을 권장"
    )
    note = (
        "\n\n---\n"
        "_※ 이 리포트는 AI 어드바이저 호출 실패 시 측정값 기반으로 자동 생성된 "
        "기본 리포트입니다. 잠시 후 새로 분석하시면 더 상세한 종합 진단을 받으실 수 있습니다._"
    )
    return "\n\n".join([sec1, sec2, sec3, sec4, sec5]) + note

# ==========================================
# [API 엔드포인트 1] 레거시 (ArUco 전용)
# ==========================================
@app.post("/api/v1/analyze-weld")
async def analyze_weld_legacy(
    file:     UploadFile = File(...),
    process:  str = Form("GTAW"),
    ai_model: str = Form("claude"),
    material: str = Form("탄소강 평판"),
):
    is_pipe = "배관" in material
    try:
        image_bytes = await file.read()
        async with httpx.AsyncClient(timeout=30) as client:
            robo_resp = await client.post(
                f"https://detect.roboflow.com/{ROBOFLOW_MODEL}?api_key={ROBOFLOW_API_KEY}",
                files={"file": ("image.jpg", image_bytes, "image/jpeg")},
            )
        if robo_resp.status_code != 200:
            return JSONResponse(status_code=502, content={"status": "error", "message": "Roboflow 서버 응답 오류"})

        roboflow_data = robo_resp.json()
        try:
            vision_data = process_vision_data(roboflow_data, is_pipe)
        except ValueError as ve:
            return JSONResponse(status_code=400, content={"status": "error", "message": str(ve)})

        expert_report = await generate_expert_report(process, vision_data, ai_model, is_pipe)
        return {
            "status": "success", "process": process, "material": material,
            "ai_model_used": ai_model, "is_pipe": is_pipe,
            "defects_summary": vision_data["defects"],
            "bead_quality":    vision_data["bead_quality"],
            "expert_report":   expert_report,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

# ==========================================
# [API 엔드포인트 2] 통합 분석 (메인)
# vision_processor → welding_calculator → gpt_advisor → 명장 리포트
# ==========================================
# ── Roboflow 호출 헬퍼 ─────────────────────────────────────────
def _rectify_for_roboflow(image_bytes: bytes, label: str) -> tuple[bytes, dict]:
    """ArUco 마커가 검출되면 호모그래피로 원근/기울기를 보정한 이미지 반환.
    실패하거나 마커 미검출 시 원본 그대로 반환.

    반환값: (image_bytes, aruco_info)
        aruco_info 는 항상 dict — success/marker_pixel_size/tilt_deg 등 포함.
        마커가 검출됐다면(보정 성공이든 실패든) marker_pixel_size > 0 이 들어옴.
    """
    info = {"success": False, "reason": "module_error", "marker_pixel_size": 0.0, "tilt_deg": 0.0}
    try:
        from aruco_rectify import rectify_image_with_aruco
        rect_bytes, info = rectify_image_with_aruco(image_bytes)
        if info.get("success"):
            print(f"[ArUco:{label}] 원근 보정 적용 "
                  f"(마커 {info['marker_pixel_size']}px, 기울기 {info['tilt_deg']:+.1f}°)")
            return rect_bytes, info
        print(f"[ArUco:{label}] 보정 미적용 ({info.get('reason')})")
    except Exception as e:
        print(f"[ArUco:{label}] 보정 모듈 오류 (무시): {e}")
        info["reason"] = f"exception:{type(e).__name__}"
    return image_bytes, info


def _inject_marker_fallback(robo_data: dict, aruco_info: dict, label: str) -> dict:
    """Roboflow 가 Reference_Marker 를 못 잡았는데 OpenCV ArUco 가 잡았다면
    합성 Reference_Marker prediction 을 주입해 분석을 진행시킨다.

    vision_processor.analyze_bead_dimensions 는 marker_pred 의 'width' 만으로
    ppm(픽셀→mm)을 계산하므로 width 만 정확하면 충분하다 (위치는 영향 없음).
    """
    preds = robo_data.get("predictions", [])
    has_marker = any(p.get("class") == "Reference_Marker" for p in preds)
    marker_px  = float(aruco_info.get("marker_pixel_size", 0) or 0)
    if has_marker or marker_px <= 0:
        return robo_data

    img_w = robo_data.get("image", {}).get("width", 1000) or 1000
    img_h = robo_data.get("image", {}).get("height", 1000) or 1000
    synth = {
        "class": "Reference_Marker",
        "width":  marker_px,
        "height": marker_px,
        "x":  img_w / 2.0,
        "y":  img_h / 2.0,
        "confidence": 0.99,
        "image_width":  img_w,
        "image_height": img_h,
        "_source": "aruco_fallback",
    }
    preds.append(synth)
    robo_data["predictions"] = preds
    print(f"[ArUco→Roboflow:{label}] 마커 폴백 주입 "
          f"({marker_px:.0f}px, ppm={marker_px / 30.0:.2f}) — "
          f"Roboflow 가 Reference_Marker 를 못 잡았지만 OpenCV ArUco 검출값으로 대체")
    return robo_data


async def _call_roboflow(image_bytes: bytes, label: str) -> dict:
    """Roboflow 호출 → predictions에 image_width/image_height 주입한 데이터 반환."""
    data = {"predictions": [], "image": {"width": 1000, "height": 1000}}
    if not ROBOFLOW_API_KEY:
        return data
    try:
        async with httpx.AsyncClient(timeout=30) as http_client:
            robo_resp = await http_client.post(
                f"https://detect.roboflow.com/{ROBOFLOW_MODEL}?api_key={ROBOFLOW_API_KEY}",
                files={"file": ("image.jpg", image_bytes, "image/jpeg")},
            )
        if robo_resp.status_code == 200:
            data = robo_resp.json()
            preds = data.get("predictions", [])
            img_w = data.get("image", {}).get("width", 1000) or 1000
            img_h = data.get("image", {}).get("height", 1000) or 1000
            # vision_processor가 사용할 수 있도록 각 prediction에 이미지 크기 주입
            for p in preds:
                p["image_width"]  = img_w
                p["image_height"] = img_h
            # 클래스별 카운트 — 어떤 결함이 검출됐는지 한눈에 보기
            from collections import Counter
            cls_counts = Counter(p.get("class", "?") for p in preds)
            cls_summary = ", ".join(f"{k}×{v}" for k, v in cls_counts.most_common()) or "없음"
            print(f"[Roboflow:{label}] 예측 {len(preds)}개 (이미지 {img_w}x{img_h}) → {cls_summary}")
        else:
            print(f"[Roboflow:{label}] HTTP {robo_resp.status_code}")
    except Exception as e:
        print(f"[Roboflow:{label}] 오류 (무시): {e}")
    return data


# ==========================================
# [필렛 분석] 각장/목두께/부등각장/오목볼록도
# ==========================================
def calculate_convexity(vision_data: dict) -> dict:
    lines = vision_data.get("straightness_lines", [])
    if not lines:
        return {"type": "unknown", "value_mm": 0}
    deviation = lines[0].get("deviation_mm", 0)
    return {
        "type": "convex" if deviation > 0 else "concave",
        "value_mm": round(deviation, 2),
        "note": "레이저 있을 때 더 정확한 측정 가능",
    }


def calculate_unequal_legs(vision_data: dict, ppm: float) -> dict:
    lines = vision_data.get("straightness_lines", [])
    if not lines:
        return {"z1": None, "z2": None, "isUnequal": False}
    polygon_pct = lines[0].get("bead_polygon_pct", [])
    if not polygon_pct:
        return {"z1": None, "z2": None, "isUnequal": False}

    xs = [p["x_pct"] for p in polygon_pct]
    ys = [p["y_pct"] for p in polygon_pct]

    root_y = max(ys)
    root_x = xs[ys.index(root_y)]

    horizontal_toe_x = min(xs)
    z2_pct = abs(horizontal_toe_x - root_x)
    vertical_toe_y = min(ys)
    z1_pct = abs(root_y - vertical_toe_y)

    z1_mm = round(z1_pct * ppm / 100, 2) if ppm > 0 else None
    z2_mm = round(z2_pct * ppm / 100, 2) if ppm > 0 else None

    is_unequal = False
    if z1_mm and z2_mm:
        is_unequal = abs(z1_mm - z2_mm) > 1.5

    return {
        "z1": z1_mm,
        "z2": z2_mm,
        "difference": round(abs((z1_mm or 0) - (z2_mm or 0)), 2),
        "isUnequal": is_unequal,
        "note": "Roboflow 정확도에 따라 오차 있을 수 있음",
    }


def calculate_fillet_analysis(vision_data: dict, ppm: float, is_fillet: bool):
    if not is_fillet:
        return None
    W = vision_data.get("bead_width_max", 0)
    if W <= 0:
        return None

    equal_leg          = round(W * 0.7071, 2)
    theoretical_throat = round(W / 2, 2)
    unequal_leg        = calculate_unequal_legs(vision_data, ppm)
    convexity          = calculate_convexity(vision_data)
    actual_throat      = round(theoretical_throat + convexity.get("value_mm", 0), 2)

    return {
        "beadWidth":         W,
        "equalLeg":          equal_leg,
        "theoreticalThroat": theoretical_throat,
        "actualThroat":      actual_throat,
        "unequalLeg":        unequal_leg,
        "convexity":         convexity,
        "note":              "부등각장은 Roboflow 정확도에 따라 오차 있을 수 있음",
    }


@app.post("/analyze-welding")
async def analyze_welding_full(
    file:           UploadFile           = File(...),
    side_file:      Optional[UploadFile] = File(None),
    back_file:      Optional[UploadFile] = File(None),
    process:        str = Form("FCAW"),
    posture:        str = Form("1G"),
    material:       str = Form("탄소강 평판"),
    bead_type:      str = Form("위빙 비드"),
    pass_type:      str = Form(""),
    ai_model:       str = Form("gpt"),
    admin_feedback: str = Form(""),
    user_history:   str = Form(""),
    plate_thickness: str = Form(""),
    pipe_outer_diameter_mm: str = Form(""),
    language: str = Form("ko"),
    is_fillet: str = Form("false"),
    has_laser: str = Form("false"),
    laser_angle_deg: str = Form("45"),
):
    # Map language code → human-readable name for the AI prompt
    LANG_NAMES_FOR_AI = {
        "ko": "Korean", "en": "English", "vi": "Vietnamese",
        "th": "Thai", "fil": "Filipino", "uz": "Uzbek", "id": "Indonesian",
    }
    language_name = LANG_NAMES_FOR_AI.get(language, "Korean")
    print(f"[Lang] AI report language: {language} → {language_name}")

    is_fillet_bool = is_fillet.lower() == "true"
    is_pipe = "배관" in material
    try:
        pipe_od_mm = float(pipe_outer_diameter_mm) if pipe_outer_diameter_mm else 0.0
    except ValueError:
        pipe_od_mm = 0.0
    if is_pipe and pipe_od_mm > 0:
        print(f"[Pipe] 외경 {pipe_od_mm}mm → 단축(원근) 왜곡 보정 활성화")

    # ── 1. 정면 이미지 읽기 + ArUco 원근 보정 ───────────────────
    image_bytes_raw = await file.read()
    image_bytes, front_aruco = _rectify_for_roboflow(image_bytes_raw, "front")
    image_base64    = base64.b64encode(image_bytes).decode()

    # ── 2. 정면 Roboflow 호출 → vision_processor ──────────────────
    front_robo  = await _call_roboflow(image_bytes, "front")
    # Roboflow 가 Reference_Marker 못 잡았으면 OpenCV ArUco 검출값으로 폴백 주입
    front_robo  = _inject_marker_fallback(front_robo, front_aruco, "front")
    front_preds = front_robo.get("predictions", [])
    vision_data = analyze_bead_dimensions(front_preds, is_pipe=is_pipe,
                                          pipe_outer_diameter_mm=pipe_od_mm)

    fillet_result = calculate_fillet_analysis(vision_data, vision_data.get("ppm", 1), is_fillet_bool)

    # 마커/비드 미탐지 시 분석 중단 — 잘못된 사진(풍경·인물·흐릿) 또는
    # 마커 누락 사진을 가짜 기본값으로 분석해 항상 같은 점수를 내는 문제 방지
    if vision_data["status"] == "error":
        msg = vision_data.get("message", "")
        print(f"[Vision:front] 분석 중단: {msg}")
        if "마커" in msg:
            user_msg = ("사진에서 30mm ArUco 마커를 찾지 못했습니다. "
                        "마커 4개 모서리가 모두 선명하게 보이도록 다시 촬영해 주세요.")
        else:
            user_msg = ("사진에서 용접 비드를 인식하지 못했습니다. "
                        "용접 비드와 30mm ArUco 마커가 함께 잘 보이는 선명한 "
                        "용접 사진을 다시 업로드해 주세요.")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "code": "INVALID_WELD_PHOTO", "message": user_msg},
        )
    print(f"[Vision:front] 폭 {vision_data['bead_width_min']}~{vision_data['bead_width_max']}mm | "
          f"직진도편차={vision_data['straightness_variance']}mm | PPM={vision_data['ppm']}")

    # ── 3. 측면 사진 처리 (있을 경우 동일 파이프라인) ──────────────
    has_side_photo   = side_file is not None
    side_vision_data = None
    if has_side_photo:
        side_bytes, side_aruco = _rectify_for_roboflow(await side_file.read(), "side")
        side_robo  = await _call_roboflow(side_bytes, "side")
        side_robo  = _inject_marker_fallback(side_robo, side_aruco, "side")
        side_preds = side_robo.get("predictions", [])
        side_vision_data = analyze_bead_dimensions(side_preds, is_pipe=is_pipe,
                                                   pipe_outer_diameter_mm=pipe_od_mm)
        if side_vision_data.get("status") == "error":
            print(f"[Vision:side] 미탐지 — 높이 점수 제외: {side_vision_data.get('message')}")
            side_vision_data = None
        else:
            print(f"[Vision:side] 높이 편차 {side_vision_data['bead_width_max'] - side_vision_data['bead_width_min']:.2f}mm")

    # ── 3-2. 이면 사진 처리 (있을 경우 동일 파이프라인 → 결함만 추가 감점) ──
    back_was_uploaded = back_file is not None  # 사진 자체가 들어왔는지 (분석 성공 여부와 별개)
    back_vision_data = None
    if back_file is not None:
        back_bytes, back_aruco = _rectify_for_roboflow(await back_file.read(), "back")
        back_robo  = await _call_roboflow(back_bytes, "back")
        back_robo  = _inject_marker_fallback(back_robo, back_aruco, "back")
        back_preds = back_robo.get("predictions", [])
        back_vision_data = analyze_bead_dimensions(back_preds, is_pipe=is_pipe,
                                                   pipe_outer_diameter_mm=pipe_od_mm)
        if back_vision_data.get("status") == "error":
            print(f"[Vision:back] 미탐지 — 이면 결함 0개로 처리: {back_vision_data.get('message')}")
            back_vision_data = None
        else:
            n_back_def = len(back_vision_data.get("defects_info", []))
            print(f"[Vision:back] 이면 결함 {n_back_def}개 검출 — 감점에 합산")

    # ── 4. welding_calculator: 새 시그니처로 점수 계산 ──────────────
    weld_data = calculate_weld_score(
        vision_data,
        has_side_photo=has_side_photo,
        side_vision_data=side_vision_data,
        back_vision_data=back_vision_data,
    )
    print(f"[Calculator] 비드총점={weld_data['bead_total_score']} 최종={weld_data['final_score']} "
          f"판정={weld_data['is_pass']}")

    # ── 5. gpt_advisor: 누적 이력 + 모든 사진(정면/측면/이면) 기반 종합 진단 ──
    expert_advice = {}
    try:
        context_meta = {
            "process":         process,
            "posture":         posture,
            "material":        material,
            "bead_type":       bead_type,
            "pass_type":       pass_type,
            "plate_thickness": plate_thickness,
        }
        # 업로드된 모든 사진을 GPT-4o 비전에 함께 전달 — 정면 high, 보조 low
        gpt_images = [{"label": "정면", "base64": image_base64}]
        if has_side_photo and side_vision_data is not None:
            gpt_images.append({
                "label": "측면",
                "base64": base64.b64encode(side_bytes).decode(),
            })
        if back_vision_data is not None:
            gpt_images.append({
                "label": "이면",
                "base64": base64.b64encode(back_bytes).decode(),
            })

        # 측면 사진이 업로드됐어도 측정에 실패했으면 GPT 가 높이 분석을 못 하도록
        # 실제 측정 성공 여부로 플래그 전달 (업로드 여부 != 측정 성공)
        has_side_measurement = side_vision_data is not None
        expert_advice = await get_expert_advice(
            gpt_images, weld_data,
            user_history=user_history,
            context_meta=context_meta,
            admin_feedback=admin_feedback,
            language_name=language_name,
            has_side_photo=has_side_measurement,
            per_photo_bead=weld_data.get("per_photo_bead"),
        )
        rep_len = len(str(expert_advice.get("comprehensiveReport", "")))
        n_imp   = len(expert_advice.get("improvements", []) or [])
        print(f"[GPT Advisor] 리포트 {rep_len}자 / 개선책 {n_imp}개 / "
              f"이력 {'있음' if user_history else '없음'} / 사진 {len(gpt_images)}장 종합")
    except Exception as e:
        print(f"[GPT Advisor] 오류: {e} — 측정값 기반 폴백 리포트로 대체")

    # ── 6. 명장 마크다운 리포트 (vision 측정값 기반) ────────────────
    raw_defects_for_report = [
        {"type": d["class"], "size_mm": d.get("size_mm", 0.0)}
        for d in vision_data.get("defects_info", [])
    ]
    bead_quality_for_report = {
        "max_width_mm":          vision_data["bead_width_max"],
        "min_width_mm":          vision_data["bead_width_min"],
        "width_variation_mm":    weld_data["width_variance"],
        "straightness_error_mm": weld_data["straightness_variance"],
    }
    pipeline_report = None
    try:
        pipeline_report = await generate_expert_report(
            process,
            {"defects": raw_defects_for_report, "bead_quality": bead_quality_for_report},
            ai_model, is_pipe,
            language_name=language_name,
        )
    except Exception as e:
        print(f"[명장 리포트] 오류: {e}")

    # ── 7. beadAnalysis 구조 — 종합(평균) + 사진별 ──────────────────
    # 종합: 모든 사진 비드 점수의 평균 (welding_calculator 가 이미 평균 계산)
    n_photos_for_avg = len([b for b in weld_data["per_photo_bead"].values() if b is not None]) or 1
    avg_label = " (사진 평균)" if n_photos_for_avg > 1 else ""
    bead_analysis = {
        "totalScore": weld_data["bead_total_score"],
        "width": {
            "value": f"{weld_data['width_variance']}mm 편차{avg_label}",
            "score": weld_data["width_score"],
        },
        "straightness": {
            "value": f"{weld_data['straightness_variance']}mm 이탈{avg_label}",
            "score": weld_data["straightness_score"],
        },
        "height": (
            {
                "value": f"{weld_data['height_variance']}mm 편차",
                "score": weld_data["height_score"],
            }
            if weld_data["height_score"] is not None else None
        ),
    }

    # 사진별 비드 분석 — 각 탭에서 해당 사진의 점수만 표시
    def _photo_bead_to_analysis(pb):
        if pb is None:
            return None
        return {
            "totalScore": pb["bead_total_score"],
            "width": {
                "value": f"{pb['width_variance']}mm 편차",
                "score": pb["width_score"],
            },
            "straightness": {
                "value": f"{pb['straightness_variance']}mm 이탈",
                "score": pb["straightness_score"],
            },
            "height": None,
        }

    front_bead_analysis = _photo_bead_to_analysis(weld_data["per_photo_bead"]["front"]) or bead_analysis
    side_bead_analysis  = _photo_bead_to_analysis(weld_data["per_photo_bead"]["side"])
    back_bead_analysis  = _photo_bead_to_analysis(weld_data["per_photo_bead"]["back"])

    # ── 8. 사진별(정면/측면/이면) 결함 표 + 히트맵 위치 데이터 빌드 ──────
    #   * 결함 표(defects): 9종류 모두 나열 — 미감지=없음/0점, 감지=측정값/-점수
    #   * defectLocations: 모든 인스턴스 (중복 제거 X — 한 종류가 N개면 N개 모두 표시)
    def _build_per_photo(defects_info: list) -> tuple[list, list]:
        # 한국명별로 인스턴스 그룹핑
        by_ko: dict = {}
        locations = []
        for d in defects_info:
            cls = d.get("class", "")
            ko_name = map_class_to_korean(cls)
            by_ko.setdefault(ko_name, []).append(d)
            locations.append({
                "name": ko_name,
                "x":    int(round(d.get("x_percent", 0))),
                "y":    int(round(d.get("y_percent", 0))),
            })

        items = []
        for name, limit, default_result in _DEFECT_TEMPLATES:
            if name in by_ko:
                instances = by_ko[name]
                sizes = [inst.get("size_mm", 0) for inst in instances]
                confs = [inst.get("confidence", 0) for inst in instances]
                max_size = max(sizes) if sizes else 0
                avg_conf = round(sum(confs) / len(confs)) if confs else 0
                count = len(instances)
                # 심각도: 균열은 무조건 심각, 그 외는 최대 크기 기반
                if "균열" in name:
                    severity = "심각"
                elif max_size >= 3.0:
                    severity = "심각"
                elif max_size >= 1.0:
                    severity = "보통"
                else:
                    severity = "경미"
                measured_text = (
                    f"{count}곳 · 최대 {max_size:.1f}mm" if count > 1
                    else f"{max_size:.1f}mm"
                )
                items.append({
                    "name": name,
                    "detected": True,
                    "severity": severity,
                    "confidence": avg_conf,
                    "standard": "선급",
                    "measured": measured_text,
                    "limit": limit,
                    "result": default_result,
                })
            else:
                items.append({
                    "name": name,
                    "detected": False,
                    "severity": "없음",
                    "confidence": 0,
                    "standard": "선급",
                    "measured": "없음",
                    "limit": limit,
                    "result": "합격",
                })
        return items, locations

    front_defects, front_locations = _build_per_photo(vision_data.get("defects_info", []))
    side_defects,  side_locations  = _build_per_photo(side_vision_data.get("defects_info", []) if side_vision_data else [])
    back_defects,  back_locations  = _build_per_photo(back_vision_data.get("defects_info", []) if back_vision_data else [])

    # 직진도 시각화 데이터 (히트맵 오버레이용)
    straightness_lines_front = vision_data.get("straightness_lines", [])
    straightness_lines_side  = side_vision_data.get("straightness_lines", []) if side_vision_data else []
    straightness_lines_back  = back_vision_data.get("straightness_lines", []) if back_vision_data else []

    # ── 9. GPT Advisor 결과에서 필드 추출 ──────────────────────────
    improvements = _extract_list(expert_advice, [
        "improvements", "교정방법", "교정_방법", "correction", "개선사항", "recommendations",
    ])
    comprehensive_report = _extract_str(expert_advice, [
        "comprehensiveReport", "종합분석", "원인분석", "analysis", "report", "summary",
    ])
    if not comprehensive_report or len(comprehensive_report) < 50:
        comprehensive_report = _build_fallback_report(weld_data, context_meta, has_side_photo)
        print(f"[GPT Advisor] 폴백 리포트 생성 — {len(comprehensive_report)}자")
    top3_defects = _extract_list(expert_advice, ["top3Defects", "주요결함", "top_defects"])
    if top3_defects == ["전문가 분석이 완료되었습니다. 상세 리포트를 확인하세요."]:
        top3_defects = weld_data["detected_defects"][:3]

    print(f"━━ 최종: aiScore={weld_data['final_score']} | 판정={weld_data['is_pass']} | "
          f"비드={weld_data['bead_total_score']} (폭{weld_data['width_score']}/직진{weld_data['straightness_score']}"
          f"{('/높이' + str(weld_data['height_score'])) if weld_data['height_score'] is not None else ''}) ━━")

    # photoAnalyses: 탭별 데이터 — 각 탭이 그 사진의 비드/결함/히트맵을 독립 표시
    # 사진이 업로드됐으나 vision 분석이 실패한 경우(비드 미식별 등)에도
    # 빈 엔트리를 만들어 프론트엔드가 "분석중/미업로드"가 아닌 정확한 메시지를 표시하게 함.
    def _empty_photo_analysis():
        return {
            "beadAnalysis":      None,
            "defects":           [],
            "defectLocations":   [],
            "straightnessLines": [],
            "analysisStatus":    "no_bead_detected",
        }

    photo_analyses = {
        "front": {
            "beadAnalysis":      front_bead_analysis,
            "defects":           front_defects,
            "defectLocations":   front_locations,
            "straightnessLines": straightness_lines_front,
        }
    }
    if has_side_photo:
        if side_vision_data is not None:
            photo_analyses["side"] = {
                "beadAnalysis":      side_bead_analysis or bead_analysis,
                "defects":           side_defects,
                "defectLocations":   side_locations,
                "straightnessLines": straightness_lines_side,
            }
        else:
            # 측면 사진은 업로드됐지만 비드/결함을 식별하지 못함
            photo_analyses["side"] = _empty_photo_analysis()
    if back_was_uploaded:
        if back_vision_data is not None:
            photo_analyses["back"] = {
                "beadAnalysis":      back_bead_analysis or bead_analysis,
                "defects":           back_defects,
                "defectLocations":   back_locations,
                "straightnessLines": straightness_lines_back,
            }
        else:
            # 이면 사진은 업로드됐지만 비드/결함을 식별하지 못함
            photo_analyses["back"] = _empty_photo_analysis()

    return {
        # 프론트엔드 호환 필드 — 최상위는 정면 데이터
        "aiScore":             weld_data["final_score"],
        "overallVerdict":      weld_data["is_pass"],
        "beadAnalysis":        bead_analysis,
        "defects":             front_defects,
        "defectLocations":     front_locations,
        "straightnessLines":   straightness_lines_front,
        "improvements":        improvements,
        "comprehensiveReport": comprehensive_report,
        "top3Defects":         top3_defects,
        "photoAnalyses":       photo_analyses,
        "beadQualityMm":  bead_quality_for_report,
        "pipelineReport": pipeline_report,
        # vision_processor 원시 측정값
        "visionMeasurement": {
            "status":                "success",
            "ppm":                   vision_data["ppm"],
            "bead_width_max":        vision_data["bead_width_max"],
            "bead_width_min":        vision_data["bead_width_min"],
            "straightness_variance": vision_data["straightness_variance"],
            "side_status":           "ok" if side_vision_data else ("none" if not has_side_photo else "miss"),
        },
        # welding_calculator 원시 출력
        "weldScore": weld_data,
        # 필렛 분석 (is_fillet=true 일 때만 non-null)
        "filletAnalysis": fillet_result,
    }

import os
import json
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))


def _build_system_prompt(language_name: str = "Korean", has_side_photo: bool = False, n_photos: int = 1) -> str:
    height_clause = (
        "bead width/straightness/height numerical interpretation"
        if has_side_photo
        else "bead width/straightness numerical interpretation (DO NOT mention or analyze "
             "bead height — the side photo was not uploaded so height cannot be measured)"
    )
    height_rule = (
        ""
        if has_side_photo
        else f"\n- CRITICAL: The trainee did NOT upload a side photo, so bead height is "
             f"UNKNOWN and unmeasurable. NEVER mention bead height, height deviation, "
             f"reinforcement height, or any height-related score in any section. Do NOT "
             f"speculate. If you would normally discuss height, instead recommend uploading "
             f"a side photo next time for height analysis.\n"
    )
    multi_view_clause = (
        f"\n- The trainee uploaded {n_photos} photos (front + additional views). "
        f"Examine ALL attached photos together and synthesize one comprehensive diagnosis "
        f"that integrates findings from every view. When you mention a defect or bead "
        f"characteristic, specify which view (front / side / back) it came from. Do NOT "
        f"analyze only the front photo — every additional view carries information you "
        f"must incorporate into the diagnosis.\n"
        if n_photos > 1
        else ""
    )
    return (
        f"You are a CWI (Certified Welding Inspector) and master craftsman with 30+ years of "
        f"experience in the Korean shipbuilding industry. Based on the trainee's welding photo, "
        f"measured values (pixel→mm converted real measurements), and their cumulative learning "
        f"history, you write a professional and warm comprehensive diagnostic report from a "
        f"coach's perspective.\n\n"
        f"VERY IMPORTANT — OUTPUT LANGUAGE:\n"
        f"Write your ENTIRE response in {language_name}. Every word — section titles, "
        f"explanations, defect interpretations, improvement actions, top3Defects entries — "
        f"MUST be written in {language_name}. Use polite/formal tone appropriate for that "
        f"language. Do NOT mix languages. The input data labels you receive may be in Korean, "
        f"but your output must be exclusively in {language_name}.\n\n"
        f"Respond with this JSON schema:\n"
        f"{{\n"
        f'  "comprehensiveReport": "long markdown analysis (1500+ characters) in {language_name}",\n'
        f'  "improvements": ["specific improvement action 1 in {language_name}", "...", "..."] (5-8 items),\n'
        f'  "top3Defects": ["3 most urgent defect names in {language_name}"]\n'
        f"}}\n\n"
        f"comprehensiveReport MUST contain exactly 5 sections as markdown headers using this "
        f"EXACT format (the parser depends on it — keep Arabic digits 1 through 5 and the '## ' "
        f"prefix; only translate the title text after the digit):\n"
        f"## 1. <Translate to {language_name}: 'This Welding Diagnosis'> — analyze the current "
        f"photo: {height_clause}, meaning of detected "
        f"defects, basis for pass/fail judgment.\n"
        f"## 2. <Translate to {language_name}: 'Learning Trend Analysis'> — when history exists: "
        f"score trend, defect pattern changes, identifying improvement/stagnation/regression "
        f"phases. If no history, start with the equivalent of 'This is the first diagnosis'.\n"
        f"## 3. <Translate to {language_name}: 'Recurring Defect Root Cause'> — if defects "
        f"repeated 2+ times exist in history, trace root causes through technical variables: "
        f"current/voltage/travel speed/posture/base material condition/wire dryness etc.\n"
        f"## 4. <Translate to {language_name}: 'Priority Improvement Actions'> — 3 things to "
        f"change in the next practice, ranked clearly as 1st / 2nd / 3rd priority.\n"
        f"## 5. <Translate to {language_name}: 'Next Practice Guide'> — concrete parameter "
        f"recommendations: current range, travel speed, torch angle, weaving width/cycle — "
        f"tailored to this trainee's process / posture / base material.\n\n"
        f"Principles:\n"
        f"- Never arbitrarily change scores or measurements. Scoring is already finished and "
        f"provided as input.\n"
        f"- Speak based on measured values (mm), not speculation.\n"
        f"- Infer the trainee's level (beginner/intermediate/advanced) from trends and adjust "
        f"your tone accordingly.\n"
        f"- No empty praise like 'good job'. Concretely point out what improved or worsened.\n"
        f"- Use practical welding terminology that field welders understand, but in "
        f"{language_name}.{multi_view_clause}{height_rule}"
    )


def _summarize_current(weld_data: dict, context_meta: dict) -> str:
    defects = weld_data.get("detected_defects", []) or []
    defect_str = ", ".join(defects) if defects else "검출된 결함 없음"
    width_var = weld_data.get("width_variance", 0)
    straight_var = weld_data.get("straightness_variance", 0)
    height_var = weld_data.get("height_variance")
    if height_var is not None:
        height_line = f"\n- 높이 편차: {height_var}mm (측면 사진)"
    else:
        height_line = (
            "\n- 비드 높이: 측면 사진 미업로드로 측정 불가 — "
            "이번 진단에서는 높이 관련 언급을 일절 하지 마세요."
        )

    return (
        f"[이번 용접 측정값 — 모든 사진 종합]\n"
        f"- 공정: {context_meta.get('process','?')} / 자세: {context_meta.get('posture','?')} / "
        f"모재: {context_meta.get('material','?')} / 비드: {context_meta.get('bead_type','?')}"
        f"{(' / 판: ' + context_meta.get('plate_thickness') + 'mm') if context_meta.get('plate_thickness') else ''}\n"
        f"- AI 최종 점수: {weld_data.get('final_score','?')}점 / 판정: {weld_data.get('is_pass','?')}\n"
        f"- 비드 폭 편차 (사진 평균): {width_var}mm\n"
        f"- 직진도 이탈 (사진 평균): {straight_var}mm{height_line}\n"
        f"- 검출 결함: {defect_str}\n"
        f"- 비드 종합 점수 (사진별 평균): {weld_data.get('bead_total_score','?')}점 "
        f"(폭{weld_data.get('width_score','?')}/직진{weld_data.get('straightness_score','?')}"
        f"{('/높이' + str(weld_data.get('height_score'))) if weld_data.get('height_score') is not None else ''})\n"
    )


def _summarize_per_photo(per_photo_bead: dict) -> str:
    """사진별 비드 점수를 보여줘 GPT가 어느 면이 나쁜지 파악하게 함."""
    if not per_photo_bead:
        return ""
    lines = ["[사진별 비드 측정값 — 각 면 독립 계산]"]
    label_map = {"front": "정면", "side": "측면", "back": "이면"}
    for key in ("front", "side", "back"):
        pb = per_photo_bead.get(key)
        if not pb:
            continue
        lines.append(
            f"- {label_map[key]}: 비드 {pb['bead_total_score']}점 "
            f"(폭편차 {pb['width_variance']}mm/{pb['width_score']}점, "
            f"직진도 {pb['straightness_variance']}mm/{pb['straightness_score']}점)"
        )
    return "\n".join(lines) + "\n"


def _summarize_history(user_history: str) -> str:
    if not user_history or not user_history.strip():
        return "[누적 이력]\n- 이번이 이 교육생의 첫 진단입니다. 추세 분석 대신 베이스라인 진단과 향후 학습 로드맵을 제시하세요.\n"
    return f"[누적 학습 이력 — 시간순 / 가장 최근 회차가 마지막 줄]\n{user_history}\n"


def _summarize_admin_feedback(admin_feedback: str) -> str:
    if not admin_feedback or not admin_feedback.strip():
        return ""
    return (
        f"\n[관리자(교관) 누적 피드백 — 최근 20건, 채점/판정 시 반드시 반영]\n{admin_feedback}\n"
    )


async def get_expert_advice(
    images: list,                # [{label: "정면"|"측면"|"이면", base64: str}, ...] — 최소 1장(정면)
    weld_data: dict,
    user_history: str = "",
    context_meta: dict | None = None,
    admin_feedback: str = "",
    language_name: str = "Korean",
    has_side_photo: bool = False,
    per_photo_bead: dict | None = None,
):
    """
    GPT-4o 비전 종합 리포트 생성. images 리스트로 모든 사진(정면/측면/이면)을 함께 전달해
    여러 시점의 결함을 하나의 종합 진단으로 통합한다.
    """
    context_meta = context_meta or {}
    if not images:
        raise ValueError("get_expert_advice requires at least 1 image (front)")

    n_photos = len(images)
    system_prompt = _build_system_prompt(language_name, has_side_photo=has_side_photo, n_photos=n_photos)

    user_text = (
        _summarize_current(weld_data, context_meta)
        + _summarize_per_photo(per_photo_bead or {})
        + "\n"
        + _summarize_history(user_history)
        + _summarize_admin_feedback(admin_feedback)
        + (
            f"\n첨부된 사진은 총 {n_photos}장입니다 — 순서: "
            f"{', '.join(img['label'] for img in images)}. 모든 사진을 반드시 함께 보고 "
            f"각 면의 결함을 종합 진단에 포함하세요. "
            if n_photos > 1
            else ""
        )
        + f"\n위 정보와 첨부 사진을 모두 종합해 위에서 지정한 JSON 스키마(5섹션 마크다운 + improvements + top3Defects)로 응답하세요. "
        f"이력이 있으면 '지난 N회차 동안 ~' 같이 회차 번호를 인용해 구체적으로 추세를 짚으세요.\n\n"
        f"REMINDER: Write the entire response (every section, every bullet, every defect name) "
        f"in {language_name}. Do not output any Korean unless {language_name} is Korean."
    )

    # 사용자 메시지: 텍스트 → [사진 라벨 + 이미지] × N
    content: list = [{"type": "text", "text": user_text}]
    for idx, img in enumerate(images):
        content.append({"type": "text", "text": f"[사진 {idx + 1}/{n_photos} — {img['label']}]"})
        # 정면은 high (가장 중요), 측면/이면은 low (토큰 절약 + 속도)
        detail = "high" if idx == 0 else "low"
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{img['base64']}",
                "detail": detail,
            },
        })

    response = await client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        max_tokens=2200,
        temperature=0.4,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
    )
    return json.loads(response.choices[0].message.content)

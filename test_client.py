import requests
import json
import os

# 1. FastAPI 서버 주소
API_URL = "http://0.0.0.0:8080/analyze-welding"

# 2. 테스트할 이미지 파일명 (이 파일이 Replit 폴더에 업로드되어 있어야 함)
IMAGE_FILE = "sample_weld.jpg"

def run_test():
    if not os.path.exists(IMAGE_FILE):
        print(f"❌ 에러: '{IMAGE_FILE}' 파일이 보이지 않습니다.")
        print("Replit 왼쪽 파일 목록에 테스트용 사진을 업로드하고 이름을 'sample_weld.jpg'로 변경해 주세요.")
        return

    print(f"🚀 분석 시작: {IMAGE_FILE}를 서버로 전송 중...")

    try:
        with open(IMAGE_FILE, "rb") as f:
            files   = {"file": (IMAGE_FILE, f, "image/jpeg")}
            payload = {"process": "CO2", "material": "강재", "ai_model": "gpt"}
            response = requests.post(API_URL, files=files, data=payload, timeout=90)

        if response.status_code == 200:
            r = response.json()

            # ── 핵심 지표 ──────────────────────────────────────────────
            ai_score  = r.get("aiScore", "N/A")
            verdict   = r.get("overallVerdict", "N/A")

            bead_mm   = r.get("beadQualityMm", {})
            max_w     = bead_mm.get("max_width_mm", "N/A")
            min_w     = bead_mm.get("min_width_mm", "N/A")
            variation = bead_mm.get("width_variation_mm", "N/A")

            vision    = r.get("visionMeasurement", {})
            ppm       = vision.get("ppm", "N/A")

            weld_sc   = r.get("weldScore", {})
            raw_score = weld_sc.get("final_score", "N/A")

            # ── 탐지된 결함 목록 ────────────────────────────────────────
            defect_list = [d["name"] for d in r.get("defects", []) if d.get("detected")]

            # ── 비드 세부 점수 ──────────────────────────────────────────
            bead_analysis = r.get("beadAnalysis", {})
            bead_total    = bead_analysis.get("totalScore", "N/A")
            width_score   = bead_analysis.get("width", {}).get("score", "N/A")
            height_score  = bead_analysis.get("height", {}).get("score", "N/A")
            straight_score= bead_analysis.get("straightness", {}).get("score", "N/A")
            pitch_score   = bead_analysis.get("pitchUniformity", {}).get("score", "N/A")

            # ── GPT/Claude 리포트 ───────────────────────────────────────
            report = r.get("pipelineReport", "")

            # ── 출력 ───────────────────────────────────────────────────
            print("\n" + "=" * 60)
            print("✅ AI 용접 분석 결과")
            print("=" * 60)
            print(f"📊 최종 점수   : {ai_score}점  ({verdict})")
            print(f"🔢 하드로직 점수: {raw_score}점")
            print(f"📏 비드 폭     : 최대 {max_w}mm / 최소 {min_w}mm  (편차 {variation}mm)")
            print(f"📐 픽셀/mm 비율: {ppm} px/mm")
            print(f"🔍 감지된 결함 : {', '.join(defect_list) if defect_list else '없음'}")
            print("-" * 60)
            print(f"🎯 비드 종합   : {bead_total}점")
            print(f"   ├ 폭 균일도 : {width_score}점")
            print(f"   ├ 높이      : {height_score}점")
            print(f"   ├ 직진도    : {straight_score}점")
            print(f"   └ 피치 균일도: {pitch_score}점")
            print("-" * 60)
            print("🧠 명장의 조언 (GPT/Claude):")
            if report:
                # 리포트가 길면 앞 500자만 미리보기
                preview = report[:500] + ("..." if len(report) > 500 else "")
                print(preview)
            else:
                improvements = r.get("improvements", [])
                for imp in improvements:
                    print(f"  • {imp}")
            print("=" * 60)
        else:
            print(f"❌ 서버 에러 ({response.status_code}): {response.text}")

    except Exception as e:
        print(f"❌ 통신 중 오류 발생: {e}")

if __name__ == "__main__":
    run_test()

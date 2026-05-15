# AI 용접 진단 시스템

## Overview
AI-powered welding quality diagnostic mobile application for Hyundai Heavy Industries. Trainees upload welding results which are analyzed by AI to provide grade scores, defect analysis, and improvement suggestions.

## Architecture

### Frontend (Expo React Native)
- **Expo Router** for file-based navigation
- **AsyncStorage** for local data persistence
- **React Context** for auth and welding data state
- **React Native SVG** for trend charts
- **expo-image-picker** for camera/gallery photo upload

### Backend (Express — Port 5000)
- Serves Expo manifest and static files
- `/api/analyze-weld` — FastAPI 프록시 (AI 연산 전부 FastAPI로 위임)
- DB 관리자 피드백 조회 후 FastAPI에 전달

### AI Pipeline (FastAPI — Port 8080)
- **모든 AI 연산의 단일 진실 공급원 (Single Source of Truth)**
- `welding_calculator.py` — Hard Logic: 비드 폭 편차 채점 + 7대 결함 감점 (선급 기준)
- `gpt_advisor.py` — Soft Logic: GPT-4o 비전 전문가 조언 (JSON)
- `main.py` → `/analyze-welding` 엔드포인트:
  - Roboflow 탐지 → ArUco 30mm 마커 기반 픽셀→mm 변환
  - `calculate_weld_score()` (Hard) + `get_expert_advice()` (Soft) 병렬 실행
  - 명장 마크다운 리포트 생성 (claude-sonnet-4-6 또는 gpt-4o)
  - 프론트엔드 호환 JSON 반환 (aiScore, beadAnalysis, defects, beadQualityMm 등)

## App Structure

```
app/
  _layout.tsx         # Root layout with auth redirect logic (post-login → /home)
  login.tsx           # Login screen (HHI logo + welding logo)
  register.tsx        # Registration with role selection (교육생/교사/관리자)
  home.tsx            # Two big cards: 이론학습 / 기량향상
  theory/
    _layout.tsx       # Stack layout for theory section
    index.tsx         # Theory hub: 오늘의 학습 / OX 퀴즈 게임
    today.tsx         # Daily 3-question quiz (하/중/상) + results + PDF export
    ox.tsx            # OX quiz placeholder (game logic deferred)
  (tabs)/
    _layout.tsx       # Skill Up tabs (NativeTabs w/ liquid glass on iOS 26+)
    index.tsx         # 실습 갤러리 - 2-column grid of welding results
    ranking.tsx       # AI 진단 순위 - 종합/주간/전일 ranking tabs
  diagnosis/
    [id].tsx          # AI analysis detail page
  register-photo.tsx  # Photo registration with welding info

context/
  AuthContext.tsx     # User auth with AsyncStorage persistence
  WeldingContext.tsx  # Welding results CRUD + AI simulation engine
  SeedData.tsx        # Demo data seeder (runs on first launch)
```

## Key Features
- **Login/Register**: Role-based (교육생/교사/관리자), profile photo upload
- **Theory Learning (이론학습)**:
  - 오늘의 학습 — 3 daily questions (1 each from 하/중/상). Picks are deterministic per user+day (KST/Asia/Seoul) and skip questions already answered on previous days. Mid-session resume after relogin: server returns the same 3 + already-saved selections.
  - Persistent attempts in `weld_theory_attempts` (Postgres). Endpoints: `daily/:userId`, `attempts` (POST), `results/:userId/:dayKey`, `history/:userId`, `today-status/:userId`.
  - Results page: per-question my-answer vs correct + explanation, 학습완료 returns to hub.
  - 복습하기 mode (`?mode=review`) shows the saved results read-only.
  - PDF export (expo-print): full accumulated history grouped by day; questions section first, then answers/explanations.
  - OX 퀴즈 게임 — placeholder page only; game logic supplied by user later.
  - Question bank: `shared/theory-questions.ts` (~196 GTAW Qs across 10 sets, 96 easy / 62 medium / 38 hard).
- **Skill Up (기량향상)**: existing tab stack (gallery/ranking) unchanged, entered from home card.
- **Gallery**: 2-column grid with AI grade badges (A+~F), star ratings, scores
- **AI Diagnosis**: Bead analysis, defect detection table, heatmap overlay, trend chart
  - Heatmap markers: yellow ref-curve, cyan raw centerline, red dot = "직진도 X.Xmm 이탈" (straightness max-deviation), purple dot = "폭 X.Xmm 이탈" (width max-deviation)
  - Worst-deviation argmax uses raw (non-smoothed) centerline against IRLS-Huber polyfit reference; 3-pt MA was removed because it dampened wobble peaks and shifted the marker to the trim boundary
- **Ranking**: Overall/weekly/daily with rise/fall indicators, top riser/faller highlights
- **Photo Registration**: Camera/gallery, welding process/posture/material, self-score vs AI-score comparison

## Demo Account
- Username: `demo` / Password: `1234` (고윤정)
- Also: `user2/1234` (아이유), `user3/1234` (김철수)

## Color Theme
Dark navy theme: `#0A0E1A` background, `#00B4FF` primary blue, `#FFB800` gold

## Photo Storage
- 교육생이 사진 업로드 시 → 서버가 구글 드라이브(`HHI_Welding_Photos` 폴더)에 자동 업로드
- DB에는 드라이브 영구 URL(`https://drive.google.com/uc?export=view&id=...`) 저장
- 기기에서 사진 삭제해도 앱에서 영구 보존됨
- Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`

## Running
- Backend: `npm run server:dev` (port 5000)
- Frontend: `npm run expo:dev` (port 8081)

## Internationalization (i18n)
- 7 languages: ko (default), en, vi, th, fil, uz, id
- All keys defined in `context/LanguageContext.tsx` (198 keys × 7 langs, full parity)
- `t(key)` falls back to Korean → key if missing; supports `{n}`/`{name}` interpolation via `.replace()`
- Translated UI: tabs, login/register, camera modal, comments, photo registration, full diagnosis screen (defects, confidence, compare bar, trend, AI summary, alerts)
- Korean strings intentionally kept: defect-name `includes()` matchers, `result.beadType === "비드 쌓기"`, `result.process/posture/material === "기타"` (these match DB-stored values)
- AI report language: frontend sends `language` → Express forwards → FastAPI maps to language name → injected into GPT-4o/Claude prompt; section headers (`## N.`) preserved in English while body content responds in user's language

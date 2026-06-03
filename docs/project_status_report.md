# AI 용접 교육 플랫폼 — 프로젝트 아키텍처 및 구현 상태 리포트

> 작성일: 2026-06-03  
> 대상 저장소: `e:\WeldingApp` (GitHub: `gmrfyd912/ai-welding-platform`)

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 프로젝트명 | AI 용접 진단 (AI Welding Diagnosis) |
| 배포 URL | https://ai-welding-platform.onrender.com |
| 현재 브랜치 | master |
| 지원 언어 | 한국어, English, Tiếng Việt, ภาษาไทย, Filipino, O'zbek, Bahasa Indonesia |

---

## 2. 기술 스택

| 레이어 | 기술 |
|--------|------|
| 모바일 앱 | React Native 0.81.5, Expo SDK 54, Expo Router, TypeScript |
| 앱 상태 관리 | React Context (Auth, Language, Welding) |
| 백엔드 API | Node.js / Express 5 (TypeScript) |
| 컴퓨터 비전 파이프라인 | Python FastAPI (port 8080) |
| 데이터베이스 | PostgreSQL (Supabase), Drizzle ORM |
| 이미지 처리 | OpenCV (cv2), expo-image-picker, expo-image-manipulator |
| AI 모델 | OpenAI GPT-4o, Anthropic Claude Sonnet, Google Gemini 2.5-flash, Roboflow |

---

## 3. 핵심 디렉토리 구조

```
WeldingApp/
├── app/                          # Expo Router 화면 (21개 파일)
│   ├── (tabs)/
│   │   ├── _layout.tsx           # 탭 네비게이션 레이아웃
│   │   ├── index.tsx             # 갤러리/홈 탭
│   │   ├── coaching.tsx          # 코칭 탭
│   │   ├── members.tsx           # 멤버 탭
│   │   └── ranking.tsx           # 랭킹/리더보드 탭
│   ├── diagnosis/[id].tsx        # 진단 결과 상세 화면
│   ├── register-photo.tsx        # 사진 업로드 & 분석 요청 화면
│   ├── coaching-live.tsx         # 실시간 코칭 화면 (Gemini)
│   ├── coaching-test.tsx         # 코칭 테스트 화면
│   ├── login.tsx                 # 로그인 화면
│   ├── register.tsx              # 회원가입 화면
│   ├── exam-record.tsx           # 자격시험 기록 화면
│   ├── theory/                   # 이론 학습 섹션
│   │   ├── index.tsx
│   │   ├── ox.tsx                # OX 퀴즈
│   │   ├── ox-game.tsx           # OX 게임
│   │   └── today.tsx             # 오늘의 이론
│   └── home.tsx
│
├── context/                      # React Context 제공자
│   ├── AuthContext.tsx           # 인증 상태
│   ├── LanguageContext.tsx       # 다국어 (7개 언어)
│   ├── WeldingContext.tsx        # 용접 도메인 데이터
│   └── SeedData.tsx              # 초기 데이터
│
├── server/                       # Express 백엔드
│   ├── index.ts                  # 서버 진입점
│   ├── routes.ts                 # 라우트 등록
│   ├── weld-analysis.ts          # FastAPI 프록시 & 재분석
│   ├── coaching-routes.ts        # Gemini 실시간 코칭
│   ├── auth-routes.ts            # 인증 엔드포인트
│   ├── results-routes.ts         # 분석 결과 CRUD
│   ├── theory-routes.ts          # 이론 학습 엔드포인트
│   ├── exam-routes.ts            # 자격시험 기록
│   ├── ox-routes.ts              # OX 퀴즈 엔드포인트
│   ├── google-drive.ts           # Google Drive 연동
│   ├── db.ts                     # PostgreSQL 연결 풀
│   ├── replit_integrations/
│   │   ├── audio/                # OpenAI TTS/STT
│   │   ├── batch/                # 배치 처리
│   │   ├── chat/                 # 채팅 연동
│   │   └── image/                # 이미지 처리
│   └── templates/
│       ├── coaching-live.html    # 실시간 코칭 웹 UI
│       └── landing-page.html     # 랜딩 페이지
│
├── main.py                       # FastAPI 서버 (978줄)
├── vision_processor.py           # 비드 치수 분석 + 레이저 격자 (686줄)
├── gpt_advisor.py                # GPT/Claude 전문가 보고서 (228줄)
├── welding_calculator.py         # 점수 계산 로직 (148줄)
├── aruco_rectify.py              # ArUco 마커 원근 보정
│
├── components/                   # 재사용 컴포넌트
├── constants/                    # 색상, 설정 상수
├── lib/                          # query-client 유틸
├── assets/                       # 이미지, 참고 자료
└── docs/                         # 프로젝트 문서
```

---

## 4. 주요 패키지 목록

### Node.js / TypeScript (package.json)

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `expo` | ~54.0.27 | 모바일 앱 프레임워크 |
| `expo-camera` | ~17.0.10 | 카메라 접근 |
| `expo-image-picker` | ~17.0.9 | 갤러리/카메라 사진 선택 |
| `expo-image-manipulator` | ^55.0.11 | 이미지 리사이징 |
| `react-native` | 0.81.5 | 모바일 코어 |
| `react-native-reanimated` | — | 애니메이션 |
| `react-native-gesture-handler` | — | 제스처 처리 |
| `react-native-svg` | — | SVG 차트 렌더링 |
| `express` | ^5.0.1 | HTTP 서버 |
| `openai` | ^6.34.0 | GPT-4o API |
| `@anthropic-ai/sdk` | ^0.88.0 | Claude API |
| `drizzle-orm` | ^0.39.3 | PostgreSQL ORM |
| `pg` | ^8.16.3 | PostgreSQL 클라이언트 |
| `googleapis` | ^148.0.0 | Google Drive / Sheets |
| `zod` | ^3.25.76 | 스키마 검증 |
| `tsx` | ^4.20.6 | TypeScript 실행 |

### Python (pip 설치 필요)

| 패키지 | 용도 |
|--------|------|
| `fastapi` | 컴퓨터 비전 파이프라인 API |
| `uvicorn` | ASGI 서버 |
| `openai` | GPT-4o 비동기 클라이언트 |
| `anthropic` | Claude 비동기 클라이언트 |
| `httpx` | 비동기 HTTP (Roboflow 호출) |
| `numpy` | 배열 연산, 통계 |
| `opencv-python` (`cv2`) | ArUco 마커 검출, 원근 보정, 레이저 격자 |

---

## 5. 핵심 기능 구현 상태

### 5-1. 카메라 / 사진 스트리밍

| 상태 | ✅ 구현 완료 |
|------|-------------|
| 관련 파일 | `app/register-photo.tsx`, `components/WeldCameraModal.tsx`, `app/(tabs)/coaching.tsx`, `server/templates/coaching-live.html` |

- `expo-camera` + `expo-image-picker`로 갤러리 선택 또는 직접 촬영
- 정면(front) / 측면(side) / 이면(back) 3장 멀티뷰 지원
- 실시간 코칭은 `coaching-live.html`에서 WebRTC/MediaDevices 스트림으로 프레임 캡처
- Android: `CAMERA`, `RECORD_AUDIO` 권한 선언

---

### 5-2. Roboflow (YOLO) 추론 연동

| 상태 | ✅ 구현 완료 |
|------|-------------|
| 관련 파일 | `main.py`, `vision_processor.py` |

**설정:**
- API Key: `ROBOFLOW_API_KEY` 환경 변수
- 모델: `ai_welding_inspection/4` (폴백: `weld-defect/3`)
- 엔드포인트: `https://detect.roboflow.com/{model}?api_key={key}`

**탐지 클래스 (11종):**

| 클래스 | 한국어 명칭 | 기준 |
|--------|------------|------|
| Crack | 균열 | AWS/ASME |
| Porosity | 기공 | AWS |
| Undercut | 언더컷 | 선급 |
| Overlap | 오버랩 | AWS |
| Spatter | 스패터 | AWS |
| Arc_Strike | 아크스트라이크 | AWS |
| Lack_of_Fusion | 용착불량 | ASME |
| Incomplete_Penetration | 용입불량 | ASME |
| Excessive_Reinforcement | 여고 | 선급 |
| Reference_Marker | 30mm 기준 마커 | — |
| Weld_Bead | 용접 비드 | — |

**파이프라인:**
1. ArUco 마커 검출 → 원근 보정 (`aruco_rectify.py`)
2. Roboflow 추론 (base64 이미지 전송)
3. ArUco 폴백 주입 (Roboflow가 마커 미탐지 시 OpenCV 결과 보완)
4. `vision_processor.py`에서 ppm 계산 → 비드 치수 측정

---

### 5-3. Gemini 2.5 Flash Live (실시간 코칭)

| 상태 | ✅ 구현 완료 |
|------|-------------|
| 관련 파일 | `server/coaching-routes.ts`, `server/templates/coaching-live.html`, `app/coaching-live.tsx` |

**설정:**
- API Key: `GEMINI_API_KEY` 환경 변수
- 모델: `gemini-2.5-flash` (기본값, `GEMINI_MODEL` 환경 변수로 변경 가능)
- 엔드포인트: `POST /api/coaching/analyze`

**동작 방식:**
- 클라이언트가 내시경 카메라 프레임을 base64로 전송
- Gemini Vision API가 프레임을 분석하여 `severity` + `message` JSON 반환
- `severity` 값: `"ok"` | `"warn"` | `"danger"`
- 메시지: 한국어 5~12단어 코칭 피드백
- `thinkingBudget: 0` (출력 토큰 절약을 위해 thinking 비활성화)

**분석 항목:**
- 아크 길이, 이동 속도, 토치 각도, 용융지 상태, 결함 발생

---

### 5-4. 음성 출력 (TTS) 및 다국어 지원

#### TTS

| 상태 | ✅ 구현 완료 |
|------|-------------|
| 관련 파일 | `server/replit_integrations/audio/routes.ts`, `server/replit_integrations/audio/client.ts`, `server/coaching-routes.ts` |

- 제공자: OpenAI TTS API
- 엔드포인트: `GET /api/coaching/tts`
- 클라이언트 훅: `useAudioPlayback.ts`, `useVoiceStream.ts`

#### 다국어 (i18n)

| 상태 | ✅ 구현 완료 |
|------|-------------|
| 관련 파일 | `context/LanguageContext.tsx` |

| 언어 코드 | 언어명 |
|-----------|--------|
| `ko` | 한국어 🇰🇷 |
| `en` | English 🇺🇸 |
| `vi` | Tiếng Việt 🇻🇳 |
| `th` | ภาษาไทย 🇹🇭 |
| `fil` | Filipino 🇵🇭 |
| `uz` | O'zbek 🇺🇿 |
| `id` | Bahasa Indonesia 🇮🇩 |

- 50개 이상의 UI 문자열 키 번역 관리
- FastAPI 분석 결과도 `language` 파라미터로 다국어 전달

---

### 5-5. NCS 매핑

| 상태 | ⚠️ 미구현 (계획 단계) |
|------|----------------------|
| 관련 파일 | 없음 (package-lock.json에 문자열만 존재) |

- NCS(국가직무능력표준) 기반 평가 체계 연동은 현재 코드에 구현되어 있지 않음
- 결함 분류 기준으로 AWS D1.1 / ASME Section IX / 선급 기준이 대신 사용됨

---

### 5-6. 결과 리포트 UI

| 상태 | ✅ 구현 완료 |
|------|-------------|
| 관련 파일 | `app/diagnosis/[id].tsx` |

**표시 섹션:**

| 섹션 | 설명 |
|------|------|
| 점수 요약 | AI 점수, 자체 점수, 등급 (A+ ~ F) |
| 비드 분석 | 너비, 직진도, 높이 — 점수 + 진행바 |
| 레이저 비드 형상 분석 | 최대/최소/평균/편차 높이, 볼록·오목 판정, SVG 막대 차트 (신규) |
| 필렛 용접 분석 | 다리 길이, 목두께, 볼록도 |
| 결함 히트맵 | 위치 오버레이 시각화 |
| AI 종합 리포트 | GPT/Claude 생성 전문가 의견 |
| 빠른 측정 모드 | AI 없이 측정값만 표시 + AI 재분석 버튼 |
| 자체 점수 비교 | 추세 라인 차트 |
| 개선 제안 | 항목별 리스트 |
| 진단 정보 | 공정, 자세, 재질, 비드 유형 |
| 댓글 | 코멘트 섹션 |

---

### 5-7. 레이저 격자 분석

| 상태 | ✅ 구현 완료 (신규) |
|------|-------------------|
| 관련 파일 | `vision_processor.py`, `main.py`, `context/WeldingContext.tsx`, `app/diagnosis/[id].tsx`, `server/weld-analysis.ts` |

**알고리즘 (`analyze_laser_grid`):**
1. 이미지 디코딩 → 그레이스케일 → GaussianBlur → Canny 엣지
2. HoughLinesP로 수평/수직 격자선 검출
3. 평탄 영역 vs 비드 영역 분리
4. 평탄 영역 y좌표 기준선 보간
5. 비드 위 격자선의 변형량(px) → 레이저 각도 삼각함수로 높이(mm) 환산
6. 최대/최소/평균/편차 통계 + 볼록·오목 판정
7. 프로파일 배열 반환 (x 위치별 높이)

**FastAPI → Node.js → 앱 전달 경로:**
```
vision_processor.analyze_laser_grid()
  → main.py visionMeasurement.laser_analysis
  → server/weld-analysis.ts laserAnalysis 필드 추가
  → WeldingContext.tsx WeldingResult.laserAnalysis 인터페이스
  → app/diagnosis/[id].tsx 레이저 분석 SectionCard 렌더링
```

---

## 6. API 엔드포인트 전체 목록

### Express (Node.js) — 포트 3000

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/health` | 헬스 체크 |
| GET | `/api/app-version` | 앱 버전 확인 |
| POST | `/api/auth/login` | 로그인 |
| POST | `/api/auth/register` | 회원가입 |
| PUT | `/api/auth/profile` | 프로필 수정 |
| GET | `/api/auth/user/:id` | 사용자 조회 |
| GET | `/api/auth/students` | 학생 목록 |
| GET | `/api/admin/users` | 전체 사용자 목록 (관리자) |
| PUT | `/api/admin/users/:id` | 사용자 수정 (관리자) |
| DELETE | `/api/admin/users/:id` | 사용자 삭제 (관리자) |
| POST | `/api/analyze-weld` | 용접 분석 (FastAPI 프록시) |
| POST | `/api/reanalyze` | 기존 결과 AI 재분석 |
| POST | `/api/upload-photo` | 사진 업로드 |
| GET | `/api/results` | 분석 결과 전체 조회 |
| GET | `/api/results/:id` | 특정 결과 조회 |
| GET | `/api/results/user/:userId` | 사용자별 결과 |
| POST | `/api/coaching/analyze` | Gemini 실시간 코칭 분석 |
| GET | `/api/coaching/tts` | TTS 음성 변환 |
| GET | `/api/theory/daily/:userId` | 오늘의 이론 |
| POST | `/api/theory/results` | 이론 학습 결과 저장 |
| GET | `/api/ox/state/:userId` | OX 퀴즈 상태 |
| POST | `/api/ox/state` | OX 상태 저장 |
| GET | `/api/ox/leaderboard` | OX 리더보드 |
| GET | `/api/exam-records` | 자격시험 기록 |
| POST | `/api/exam-records` | 자격시험 기록 생성 |

### FastAPI (Python) — 포트 8080

| Method | Path | 설명 |
|--------|------|------|
| GET | `/` | 헬스 체크 (ping) |
| POST | `/analyze-welding` | 용접 영상 분석 파이프라인 |

---

## 7. 분석 모드

| 모드 | 값 | 동작 |
|------|-----|------|
| 빠른 측정 | `quick` | Roboflow + Vision만 실행, AI 보고서 생략 (~5초) |
| AI 종합 분석 | `ai` | GPT/Claude 전문가 보고서 + 개선 제안 포함 (~30~90초) |

- 기본값: `quick`
- AI 모델 선택: `gpt-4o` 또는 `claude-sonnet`
- 빠른 측정 후 결과 화면에서 AI 재분석 버튼으로 업그레이드 가능

---

## 8. 데이터베이스 구조

- **엔진:** PostgreSQL (Supabase, ap-northeast-2)
- **ORM:** Drizzle ORM

**주요 테이블:**

| 테이블 | 설명 |
|--------|------|
| `weld_users` | 사용자 계정 및 프로필 |
| `weld_results` | 용접 분석 결과 (AI 점수, 결함, 비드 분석 등) |
| `weld_comments` | 결과별 댓글 |
| `weld_ox_state` | OX 퀴즈 진행 상태 |
| `admin_feedback` | 관리자 피드백 (FastAPI 프롬프트에 주입) |
| `exam_records` | 자격시험 기록 |

---

## 9. 환경 변수 목록

| 변수명 | 설명 |
|--------|------|
| `ROBOFLOW_API_KEY` | Roboflow 추론 API 키 |
| `ROBOFLOW_MODEL_ID` | Roboflow 모델 ID (기본: `ai_welding_inspection/4`) |
| `OPENAI_API_KEY` | OpenAI GPT-4o + TTS API 키 |
| `ANTHROPIC_API_KEY` | Anthropic Claude API 키 |
| `GEMINI_API_KEY` | Google Gemini API 키 |
| `DATABASE_URL` | PostgreSQL 연결 문자열 |
| `EXPO_PUBLIC_DOMAIN` | 앱이 바라보는 백엔드 URL |
| `SESSION_SECRET` | Express 세션 비밀키 |
| `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 비밀 키 |
| `GOOGLE_REFRESH_TOKEN` | Google Drive 접근 토큰 |
| `GEMINI_MODEL` | Gemini 모델명 (기본: `gemini-2.5-flash`) |

---

## 10. 구현 상태 요약

| 기능 | 상태 | 비고 |
|------|------|------|
| 카메라/사진 업로드 | ✅ 완료 | 멀티뷰 3장, 갤러리/직접 촬영 |
| Roboflow 결함 탐지 | ✅ 완료 | 11개 클래스, ArUco 폴백 |
| ArUco 마커 원근 보정 | ✅ 완료 | `aruco_rectify.py` |
| 비드 치수 분석 | ✅ 완료 | 너비, 직진도, 높이 |
| 레이저 격자 분석 | ✅ 완료 (신규) | 삼각함수 기반 높이 측정 |
| GPT-4o 전문가 보고서 | ✅ 완료 | AI 종합 분석 모드 |
| Claude Sonnet 보고서 | ✅ 완료 | AI 종합 분석 모드 (대체) |
| Gemini 실시간 코칭 | ✅ 완료 | `gemini-2.5-flash`, 프레임 분석 |
| TTS 음성 출력 | ✅ 완료 | OpenAI TTS, 코칭 피드백 |
| 다국어 지원 (7개국어) | ✅ 완료 | `LanguageContext.tsx` |
| 빠른 측정 / AI 분석 모드 | ✅ 완료 | UI 계층형 선택, 기본 quick |
| AI 재분석 | ✅ 완료 | 빠른 측정 결과 → AI 업그레이드 |
| 결과 리포트 화면 | ✅ 완료 | 레이저 차트 포함 |
| 이론 학습 / OX 퀴즈 | ✅ 완료 | 일별 퀴즈, 리더보드 |
| 자격시험 기록 | ✅ 완료 | 기록 생성/조회/삭제 |
| 관리자 피드백 주입 | ✅ 완료 | DB → FastAPI 프롬프트 |
| NCS 매핑 | ⚠️ 미구현 | AWS/ASME 기준으로 대체 중 |

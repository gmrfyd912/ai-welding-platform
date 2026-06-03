# 사진 업로드 · 분석 요청 · 진단 UI 현재 상태 리포트

> 스캔 기준일: 2026-06-03  
> 대상 파일: `app/register-photo.tsx`, `app/diagnosis/[id].tsx`

---

## 1. 업로드 화면 (`register-photo.tsx`) — 폼 항목 전체

### 1-1. UI 섹션 구성 (ScrollView 내 렌더링 순서)

| 순번 | 섹션명 | 상태 변수 | 비고 |
|------|--------|----------|------|
| 1 | 등록자 정보 | `user` (Context) | 이름/역할/과정명 표시 (읽기 전용) |
| 2 | **레이저 보조** | `hasLaser` (`boolean`) | 토글 2버튼: 없음 / 있음 |
| 3 | **사진 업로드** | `photos` (`Record<"front"\|"side"\|"back", string\|null>`) | 정면 필수, 측면·이면 선택 |
| 4 | **용접 공정** | `process` (`WeldProcess`) | ChipSelect 7종 + 기타 직접입력 |
| 5 | **용접 자세** | `posture` (`WeldPosture`) | ChipSelect 12종 + 기타 직접입력 |
| 5-a | ∟ **필렛 여부** | `isFillet` (`boolean`) | 1F~5F 선택 시 자동 `true`, 수동 토글도 가능 |
| 6 | **용접 재질** | `material` (`WeldMaterial`) | ChipSelect 4종 + 기타 직접입력 |
| 6-a | ∟ **배관 외경** | `pipeOuterDiameter` (`string`, mm) | 재질이 `배관` 포함 시에만 표시; 표준 호칭 조회 모달 제공 |
| 7 | **자체 점수** | `selfScore` (`string` → `number`) | 0~100 숫자 입력 (필수), 등급 뱃지 실시간 표시 |
| 8 | **분석 모드** | `analysisMode` (`"quick"\|"ai"`) | 기본값 `"quick"` |
| 8-a | ∟ **AI 모델** | `selectedAI` (`"gpt-4o"\|"claude-sonnet"`) | `analysisMode === "ai"` 일 때만 표시 |

### 1-2. 현재 UI에 없는 잠재 입력 항목

| 항목 | 서버 수신 여부 | 현재 상태 |
|------|-------------|----------|
| 비드 유형 (`beadType`) | ✅ 서버 `req.body`에서 구조분해 | ❌ UI 없음 — payload에 미포함 |
| 패스 유형 (`passType`) | ✅ 서버 `req.body`에서 구조분해 | ❌ UI 없음 — payload에 미포함 |
| 판재 두께 (`plateThickness`) | ✅ 서버 `req.body`에서 구조분해 | ❌ UI 없음 — payload에 미포함 |
| 전류 / 전압 / 와이어경 | ❌ 서버 수신 안 함 | ❌ UI 없음 — 전체 미구현 |
| 레이저 각도 (`laser_angle_deg`) | ✅ FastAPI 수신 | 🔶 카메라 촬영 화면(`WeldCameraModal`)에서 선택 — 갤러리 선택 시 전달 불가 |

---

## 2. 분석 요청 페이로드 구조

`handleSubmit()` → `POST /api/analyze-weld`

```json
{
  "photos": {
    "front": "<base64 JPEG>",
    "side":  "<base64 JPEG | undefined>",
    "back":  "<base64 JPEG | undefined>"
  },
  "process":  "FCAW | GTAW | SAW | EGW | 오토캐리지용접 | 협동로봇 용접 | <기타 직접입력>",
  "posture":  "1G | 2G | 3G | 4G | 5G | 6G | 1F | 2F | 3F | 4F | 5F | <기타 직접입력>",
  "material": "탄소강 평판 | 탄소강 배관 | 스테인리스 평판 | 스테인리스강 배관 | <기타 직접입력>",
  "selfScore": 75,
  "previousResultsSummary": "<이전 분석 기록 요약 | undefined>",
  "pipeOuterDiameterMm": "114.3 | undefined",
  "language": "ko | en | vi | th | fil | uz | id",
  "aiModel": "gpt-4o | claude-sonnet",
  "isFillet": false,
  "hasLaser": false,
  "analysisMode": "quick | ai"
}
```

### 2-1. 이미지 전처리 파이프라인

```
원본 URI
  └── ImageManipulator.manipulateAsync()   ← EXIF 회전 정규화 (AI 방향 오인 방지)
        └── compress: 0.85, JPEG
              └── FileSystem.readAsStringAsync() → Base64 문자열
```

- **갤러리 선택**: `ImagePicker.launchImageLibraryAsync({ quality: 0.8 })`
- **직접 촬영**: `WeldCameraModal` (ArUco 가이드 오버레이 포함) → `handleCameraCapture(uri, laserAngleDeg?)`

### 2-2. 사진 업로드 후처리 (fire-and-forget)

```
분석 완료 → addResult(newResult)  ← 썸네일(400px, 55%) 즉시 로컬 저장
  └── router.push("/diagnosis/[id]")  ← 즉시 화면 전환
        └── [백그라운드] uploadPhoto() → /api/upload-photo (Google Drive)
              └── 성공 시 updatePhotos(resultId, driveUrl, ...) → DB URL 교체
```

### 2-3. 단계별 진행 문자열 (UI 표시)

| 지연(ms) | 표시 텍스트 |
|---------|------------|
| 0 | `stage_preparing` (준비 중) |
| 1500 | `stage_detecting` (결함 탐지) |
| 6000 | `stage_measuring` (치수 측정) |
| 10000 | `stage_aiAnalyzing` (AI 분석 중) |
| 22000 | `stage_writingReport` (보고서 작성) |

---

## 3. 분석 모드 분기 로직 (1단계 → 2단계)

### 3-1. 1단계 — 빠른 측정 (`analysisMode: "quick"`)

```
POST /api/analyze-weld { analysisMode: "quick" }
  └── Node.js → FastAPI /analyze-welding { analysis_mode: "quick" }
        ├── Roboflow 추론 (결함 탐지)
        ├── vision_processor (비드 치수 + 레이저)
        ├── welding_calculator (점수 계산)
        └── [SKIP] gpt_advisor / generate_expert_report
              └── 반환: aiScore, beadAnalysis, defects, top3Defects
                        improvements=[], comprehensiveReport=null
```

**판별 조건 (`isQuickMode`):**
```typescript
const isQuickMode = !result.comprehensiveReport &&
                    (!result.improvements || result.improvements.length === 0);
```

### 3-2. 2단계 — AI 종합 분석 호출

**진입점 A: 업로드 시 `analysisMode: "ai"` 선택**

```
POST /api/analyze-weld { analysisMode: "ai" }
  └── FastAPI: gpt_advisor() + generate_expert_report() 실행
        └── 반환: comprehensiveReport (마크다운 5섹션), improvements[], top3Defects
```

**진입점 B: 결과 화면에서 재분석 버튼**

```
[빠른 측정 모드] SectionCard
  └── "AI 종합 분석 실행" 버튼 → handleReanalyze()
        └── POST /api/reanalyze { resultId }
              ├── DB에서 기존 사진 URL 조회
              ├── URL → base64 변환
              ├── callFastApiAnalyze({ analysisMode: "ai" })
              ├── DB 업데이트 (ai_score, comprehensive_report, improvements, ...)
              └── 성공 → refreshResults() → UI 자동 갱신 (isQuickMode 재판별)
```

---

## 4. 진단 결과 화면 (`diagnosis/[id].tsx`) — UI 섹션 현황

### 4-1. 전체 섹션 렌더링 구조

```
DiagnosisScreen
├── [프로필] 이름 / 랭킹 / 과정명 / AI 점수
├── [통계] 총 평가 횟수 / 최근 등급 / 평균 / 최고 점수  (StatCard ×4)
│
├─ SectionCard: 비드 분석 (diag_beadAnalysis)          ← 항상 표시
│   ├── PhotoTabBar (다중 사진일 때)
│   ├── 너비 / 직진도 — 항상
│   └── 높이 (ba.height 있을 때만)                     ← ⚠️ 측면 사진 분석 시에만 채워짐
│
├─ SectionCard: 레이저 비드 형상 분석                   ← 조건부: laserAnalysis.status === "success"
│   ├── StatCard ×4: 최대/최소/평균 높이, 높이 편차
│   ├── 볼록·오목·평탄 판정 뱃지
│   ├── SVG 바 차트 (profile 배열, 볼록=주황 / 오목=파란 / 0선=회색점선)
│   └── 격자 간격 + 이탤릭 안내
│
├─ SectionCard: 필렛 용접 분석                          ← 조건부: result.filletAnalysis != null
│   ├── 비드 너비, 등각장(Z)
│   ├── 수직 각장(Z1), 수평 각장(Z2)
│   ├── 이론 목두께, 실제 목두께
│   ├── 부등각장 (경고 뱃지)
│   └── 비드 형상 (볼록/오목/평탄 + mm)
│
├─ SectionCard: 결함 평가 (diag_defectEval)             ← 항상 표시
│   └── DefectRow 테이블 (측정값 / 기준 / 감점)
│
├─ [isQuickMode 분기]
│   ├─ true → SectionCard: 빠른 측정 모드              ← 재분석 버튼 포함
│   │   └── "AI 종합 분석 실행" 버튼 → POST /api/reanalyze
│   └─ false → SectionCard: AI 종합 리포트 (diag_aiReport)
│       ├── 합격/불합격 판정 배너
│       ├── Top 3 결함 목록
│       └── comprehensiveReport (5섹션 마크다운 파서로 렌더링)
│
├─ SectionCard: 결함 히트맵 (diag_heatmap)              ← 항상 표시
│   ├── 비드 폴리곤 오버레이 (하늘색 면)
│   ├── 기준 곡선 (노란 실선)
│   ├── 실제 중심선 (시안 점선)
│   ├── 최대 이탈점 (빨간 원 + 편차 텍스트)
│   ├── 폭 최대 편차점 (보라 원)
│   └── 결함 마커 (원형, 색상 = 심각도)
│
├─ SectionCard: 자체 점수 비교 (diag_selfCompare)       ← 항상 표시
│   └── 자체/AI 점수 진행바 + 과소/과대/정확 평가
│
├─ SectionCard: 개선 제안 (diag_improvements)           ← 조건부: !isQuickMode
│   └── 우선순위별 개선 팁 리스트
│
└─ SectionCard: 추세 (diag_trend)                       ← 항상 표시
    └── 누적 AI 점수 꺾은선 차트
```

### 4-2. 3D 레이저 데이터 렌더링 현황

| 데이터 항목 | 데이터 경로 | 화면 표시 | 상태 |
|------------|-----------|---------|------|
| 비드 최대 높이 | `laserAnalysis.beadHeightMax` | StatCard "최대 높이" | ✅ 구현 |
| 비드 최소 높이 | `laserAnalysis.beadHeightMin` | StatCard "최소 높이" | ✅ 구현 |
| 비드 평균 높이 | `laserAnalysis.beadHeightAvg` | StatCard "평균 높이" | ✅ 구현 |
| 높이 편차 | `laserAnalysis.heightVariance` | StatCard "높이 편차" | ✅ 구현 |
| 볼록/오목 판정 | `laserAnalysis.convexity` | 색상 뱃지 (볼록=주황, 오목=파란, 평탄=초록) | ✅ 구현 |
| 높이 프로파일 | `laserAnalysis.profile[]` | SVG 막대 차트 | ✅ 구현 |
| 격자 간격 | `laserAnalysis.laserGridSpacingMm` | 회색 텍스트 | ✅ 구현 |
| 교차검증 신뢰도 | `laserAnalysis.confidence_score` | — | ❌ **미구현** |
| 보정 프로파일 | `laserAnalysis.corrected_profile[]` | — | ❌ **미구현** |
| 구간별 오차 | `laserAnalysis.segment_errors[]` | — | ❌ **미구현** |
| 필렛 각장 Z | `filletAnalysis.equalLeg` | "등각장(Z)" 행 | ✅ 구현 |
| 필렛 수직각장 Z1 | `filletAnalysis.unequalLeg.z1` | "수직 각장(Z1)" 행 | ✅ 구현 |
| 필렛 수평각장 Z2 | `filletAnalysis.unequalLeg.z2` | "수평 각장(Z2)" 행 | ✅ 구현 |
| 이론 목두께 | `filletAnalysis.theoreticalThroat` | "이론 목두께" 행 | ✅ 구현 |
| 실제 목두께 | `filletAnalysis.actualThroat` | "실제 목두께" 행 | ✅ 구현 |
| 부등각장 | `filletAnalysis.unequalLeg.isUnequal` | 경고 뱃지 (차이 mm) | ✅ 구현 |
| 비드 볼록도 | `filletAnalysis.convexity` | 볼록/오목/평탄 + mm | ✅ 구현 |

### 4-3. 조건부 표시 항목 요약

| 항목 | 표시 조건 |
|------|----------|
| 레이저 비드 형상 분석 섹션 | `result.laserAnalysis?.status === "success"` |
| 필렛 용접 분석 섹션 | `result.filletAnalysis != null` |
| 비드 높이 (항목) | `currentPhotoAnalysis.beadAnalysis.height != null` |
| AI 종합 리포트 섹션 | `!isQuickMode` (comprehensiveReport 또는 improvements가 있을 때) |
| 개선 제안 섹션 | `!isQuickMode` |
| 빠른 측정 모드 + 재분석 버튼 | `isQuickMode` |
| 멀티뷰 탭 (정면/측면/이면) | `hasMultiplePhotos` (photos.side 또는 photos.back 존재) |
| 히트맵 직진도 오버레이 | `showHeatmap && currentPhotoAnalysis && imgRenderedSize && imgNaturalSize` |

---

## 5. 미구현 / 개선 필요 항목

### 5-1. 업로드 폼에서 누락된 메타데이터

| 항목 | 우선순위 | 비고 |
|------|---------|------|
| `beadType` (위빙/스트레이트 비드) | 🟡 중 | 서버·FastAPI에서 이미 처리 가능, UI만 없음 |
| `passType` (싱글/멀티 패스) | 🟡 중 | 서버·FastAPI에서 이미 처리 가능, UI만 없음 |
| `plateThickness` (판재 두께 mm) | 🟡 중 | 서버·FastAPI에서 이미 처리 가능, UI만 없음 |
| 전류 / 전압 / 와이어경 | 🟢 저 | 서버·FastAPI 로직 신설 필요 |

### 5-2. 진단 화면에서 누락된 렌더링

| 항목 | 현황 | 개선 방향 |
|------|------|---------|
| 교차검증 신뢰도 (`confidence_score`) | 데이터 있음, 화면 없음 | 레이저 섹션에 신뢰도 배지 추가 |
| 보정 프로파일 (`corrected_profile`) | 데이터 있음, 화면 없음 | 원본·보정 프로파일 비교 차트 추가 |
| 구간별 오차 (`segment_errors`) | 데이터 있음, 화면 없음 | 이상치 구간 강조 표시 추가 |
| 분석 모드 표시 (quick/ai 구분 뱃지) | 화면에 없음 | 헤더 또는 정보 섹션에 표시 |
| 메타데이터 정보 섹션 (전류/전압) | 화면에 없음 | 진단 정보 섹션 확장 필요 |

### 5-3. 레이저 각도 전달 gap

```
카메라 촬영 경로:  WeldCameraModal → handleCameraCapture(uri, laserAngleDeg?) → 현재 laserAngleDeg 미사용
갤러리 선택 경로:  laserAngleDeg 전달 자체 불가
→ hasLaser=true 시에도 FastAPI로 laser_angle_deg=45(기본값)만 전송됨
```

---

## 6. 데이터 흐름 전체 다이어그램

```
[앱 사용자]
    │
    ▼
register-photo.tsx
    ├── 폼: 공정/자세/재질/필렛/레이저/점수/분석모드/AI모델
    └── handleSubmit()
          │
          ▼
    POST /api/analyze-weld (Node.js Express)
          ├── adminFeedback 조회 (DB)
          ├── 최대 3회 재시도 (콜드스타트 대응)
          └── POST /analyze-welding (FastAPI :8080)
                ├── ArUco 원근 보정
                ├── Roboflow 추론 (11종 클래스)
                ├── vision_processor:
                │     ├── analyze_bead_dimensions() → 너비/직진도/레이저
                │     ├── estimate_bead_robust()    → IRLS Huber 2D 추정
                │     └── fuse_and_validate()       → 교차검증 + 신뢰도
                ├── welding_calculator → 점수 계산
                └── [analysisMode="ai"만]
                      ├── gpt_advisor() → GPT/Claude 전문가 보고서
                      └── generate_expert_report() → 5섹션 마크다운
                            │
                            ▼
    ◄──────── JSON 응답 ────────────
          │
          ▼
    addResult() → WeldingContext (로컬 + DB)
          │
          ▼
diagnosis/[id].tsx
    ├── [항상] 비드 분석 / 결함 평가 / 히트맵 / 자체 비교 / 추세
    ├── [조건부] 레이저 형상 분석 (hasLaser + 성공 시)
    ├── [조건부] 필렛 분석 (isFillet 시)
    └── [분기]
          ├── isQuickMode → "빠른 측정" + 재분석 버튼
          └── AI모드 → AI 종합 리포트 (5섹션)
                            │
                 재분석 버튼 onPress
                            ▼
                POST /api/reanalyze { resultId }
                      ├── DB에서 사진 URL 조회 → base64 변환
                      ├── callFastApiAnalyze({ analysisMode: "ai" })
                      ├── DB UPDATE (ai_score, comprehensive_report, ...)
                      └── res.json(aiData) → refreshResults() → UI 갱신
```

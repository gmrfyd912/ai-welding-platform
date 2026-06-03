import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import type { WeldingResult } from "@/context/WeldingContext";

// ── HTML 이스케이프 ──────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── 등급 색상 ────────────────────────────────────────────────────
function gradeColor(score: number): string {
  if (score >= 90) return "#6366f1";
  if (score >= 80) return "#22c55e";
  if (score >= 70) return "#f59e0b";
  if (score >= 60) return "#f97316";
  return "#ef4444";
}

// ── 날짜 포맷 ────────────────────────────────────────────────────
function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── HTML 빌더 ────────────────────────────────────────────────────
function buildHtml(result: WeldingResult): string {
  const scoreColor = gradeColor(result.aiScore);
  const isFillet = result.filletAnalysis != null;
  const fa = result.filletAnalysis;
  const la = result.laserAnalysis;
  const detectedDefects = result.defects.filter((d) => d.detected);

  /* ── 비드 분석 행 ── */
  const beadRows = (() => {
    const ba = result.beadAnalysis;
    if (!ba) return "";
    const rows = [
      ["비드 폭 균일성", esc(ba.width.value), `${ba.width.score}점`],
      ["직진도", esc(ba.straightness.value), `${ba.straightness.score}점`],
      ...(ba.height ? [["비드 높이", esc(ba.height.value), `${ba.height.score}점`]] : []),
    ];
    return rows.map(([l, v, s]) =>
      `<tr><td>${l}</td><td>${v}</td><td><b>${s}</b></td></tr>`
    ).join("");
  })();

  /* ── 필릿 분석 섹션 ── */
  const filletSection = fa ? `
    <h2>필릿 비드 분석</h2>
    <table>
      <tr><th>항목</th><th>측정값</th></tr>
      <tr><td>등각장 (Z)</td><td>${esc(fa.equalLeg)}mm</td></tr>
      <tr><td>수직 각장 (Z1)</td><td>${fa.unequalLeg.z1 != null ? esc(fa.unequalLeg.z1) + "mm" : "-"}</td></tr>
      <tr><td>수평 각장 (Z2)</td><td>${fa.unequalLeg.z2 != null ? esc(fa.unequalLeg.z2) + "mm" : "-"}</td></tr>
      <tr><td>이론 목두께</td><td>${esc(fa.theoreticalThroat)}mm</td></tr>
      <tr><td>실제 목두께</td><td>${esc(fa.actualThroat)}mm</td></tr>
      <tr><td>부등각장</td><td>${fa.unequalLeg.isUnequal ? `⚠ 차이 ${esc(fa.unequalLeg.difference)}mm` : "균등"}</td></tr>
      <tr><td>비드 형상</td><td>${esc(fa.convexity.type === "convex" ? "볼록" : fa.convexity.type === "concave" ? "오목" : "평탄")} (${esc(fa.convexity.value_mm)}mm)</td></tr>
    </table>` : "";

  /* ── 레이저 분석 섹션 ── */
  const laserSection = (la && la.status === "success") ? `
    <h2>레이저 비드 형상 분석</h2>
    ${la.is_cross_validated ? `<p class="badge">AI 교차검증 신뢰도: ${(la.confidence_score ?? 0).toFixed(1)}%</p>` : ""}
    ${(la.segment_errors?.some((e) => e.is_outlier)) ? `<p class="warn">⚠ AI 레이저 오차 보정됨</p>` : ""}
    <table>
      <tr><th>항목</th><th>값</th></tr>
      <tr><td>최대 높이</td><td>${la.beadHeightMax.toFixed(2)}mm</td></tr>
      <tr><td>최소 높이</td><td>${la.beadHeightMin.toFixed(2)}mm</td></tr>
      <tr><td>평균 높이</td><td>${la.beadHeightAvg.toFixed(2)}mm</td></tr>
      <tr><td>높이 편차</td><td>${la.heightVariance.toFixed(2)}mm</td></tr>
      <tr><td>형상</td><td>${la.convexity === "convex" ? "볼록" : la.convexity === "concave" ? "오목" : "평탄"} (${la.convexityMm.toFixed(2)}mm)</td></tr>
      <tr><td>격자 간격</td><td>${la.laserGridSpacingMm.toFixed(2)}mm</td></tr>
    </table>` : "";

  /* ── 결함 섹션 ── */
  const defectRows = detectedDefects.length > 0
    ? detectedDefects.map((d) => `
        <tr>
          <td>${esc(d.name)}</td>
          <td>${esc(d.severity)}</td>
          <td>${esc(d.measured)}</td>
          <td>${esc(d.limit)}</td>
          <td style="color:${d.result === "불합격" ? "#ef4444" : d.result === "경고" ? "#f59e0b" : "#22c55e"}">${esc(d.result)}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" style="text-align:center;color:#888">탐지된 결함 없음</td></tr>`;

  /* ── 개선 제안 ── */
  const improvementsSection = (result.improvements && result.improvements.length > 0) ? `
    <h2>개선 제안</h2>
    <ul>${result.improvements.map((tip) => `<li>${esc(tip)}</li>`).join("")}</ul>` : "";

  /* ── AI 종합 리포트 ── */
  const aiReportSection = result.comprehensiveReport ? `
    <h2>AI 종합 분석 리포트</h2>
    <div class="report-box">${esc(result.comprehensiveReport).replace(/\n/g, "<br/>")}</div>` : "";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>AI 용접 진단 리포트</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Malgun Gothic', Arial, sans-serif; font-size: 13px; color: #1e1e2e; background: #fff; padding: 24px; }
    .header { background: linear-gradient(135deg,#1e3a5f,#0d1528); color:#fff; border-radius:12px; padding:24px; margin-bottom:20px; }
    .header h1 { font-size:22px; margin-bottom:4px; }
    .header .sub { font-size:12px; opacity:0.7; }
    .score-box { display:flex; align-items:center; gap:16px; margin-top:14px; }
    .big-score { font-size:52px; font-weight:900; color:${scoreColor}; line-height:1; }
    .score-info { display:flex; flex-direction:column; gap:4px; }
    .grade-badge { display:inline-block; background:${scoreColor}22; color:${scoreColor}; border:1.5px solid ${scoreColor}55; border-radius:8px; padding:3px 12px; font-weight:700; font-size:15px; }
    .verdict { font-size:18px; font-weight:700; color:${result.overallVerdict === "PASS" ? "#22c55e" : "#ef4444"}; margin-top:4px; }
    h2 { font-size:15px; font-weight:700; color:#1e3a5f; margin:18px 0 8px; padding-bottom:4px; border-bottom:2px solid #e2e8f0; }
    table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:8px; }
    th { background:#f1f5f9; color:#64748b; font-weight:600; padding:7px 10px; text-align:left; border:1px solid #e2e8f0; }
    td { padding:6px 10px; border:1px solid #e2e8f0; vertical-align:middle; }
    tr:nth-child(even) td { background:#f8fafc; }
    .badge { display:inline-block; background:#dbeafe; color:#1d4ed8; border-radius:6px; padding:2px 10px; font-size:12px; font-weight:600; margin-bottom:6px; }
    .warn { display:inline-block; background:#fef9c3; color:#92400e; border-radius:6px; padding:2px 10px; font-size:12px; font-weight:600; margin-bottom:6px; }
    ul { padding-left:18px; }
    li { margin:4px 0; font-size:12px; line-height:1.6; }
    .report-box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px; font-size:12px; line-height:1.8; white-space:pre-wrap; word-break:break-word; }
    .footer { margin-top:24px; text-align:center; font-size:11px; color:#94a3b8; border-top:1px solid #e2e8f0; padding-top:12px; }
    .meta-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:4px; }
    .meta-item { background:#f1f5f9; border-radius:8px; padding:8px 12px; }
    .meta-label { font-size:10px; color:#94a3b8; margin-bottom:2px; }
    .meta-value { font-size:13px; font-weight:600; color:#1e293b; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔧 AI 용접 진단 리포트</h1>
    <div class="sub">${esc(formatDate(result.timestamp))} · ${esc(result.userName)}</div>
    <div class="score-box">
      <div class="big-score">${result.aiScore}</div>
      <div class="score-info">
        <span class="grade-badge">${esc(result.grade)}</span>
        <span class="verdict">${result.overallVerdict === "PASS" ? "✓ 합격" : "✗ 불합격"}</span>
        <span style="font-size:12px;color:#94a3b8;margin-top:2px;">자체 점수: ${result.selfScore}점</span>
      </div>
    </div>
  </div>

  <h2>용접 정보</h2>
  <div class="meta-grid">
    <div class="meta-item"><div class="meta-label">공정</div><div class="meta-value">${esc(result.process)}</div></div>
    <div class="meta-item"><div class="meta-label">자세</div><div class="meta-value">${esc(result.posture)}</div></div>
    <div class="meta-item"><div class="meta-label">재질</div><div class="meta-value">${esc(result.material)}</div></div>
    ${result.beadType ? `<div class="meta-item"><div class="meta-label">비드 유형</div><div class="meta-value">${esc(result.beadType)}</div></div>` : ""}
    ${result.passType ? `<div class="meta-item"><div class="meta-label">패스 유형</div><div class="meta-value">${esc(result.passType)}</div></div>` : ""}
    <div class="meta-item"><div class="meta-label">용접 종류</div><div class="meta-value">${isFillet ? "필릿 용접" : "맞대기 용접"}</div></div>
  </div>

  <h2>${isFillet ? "필릿" : "맞대기"} 비드 분석 (AI 점수 기준)</h2>
  <table>
    <tr><th>항목</th><th>측정값</th><th>점수</th></tr>
    ${beadRows || `<tr><td colspan="3" style="text-align:center;color:#888">데이터 없음</td></tr>`}
  </table>
  <p style="font-size:11px;color:#94a3b8;margin-top:4px;">※ 최종 점수 = 비드 형상 점수 (${isFillet ? "각장 35% + 목두께 25% + 부등각장 20% + 볼록도 20%" : "폭 30% + 직진도 30% + 높이 20% + 기본 20%"}) − 결함 감점</p>

  ${filletSection}
  ${laserSection}

  <h2>결함 평가</h2>
  <table>
    <tr><th>결함명</th><th>심각도</th><th>측정값</th><th>기준</th><th>결과</th></tr>
    ${defectRows}
  </table>

  ${improvementsSection}
  ${aiReportSection}

  <div class="footer">
    AI 용접 진단 플랫폼 · 본 리포트는 AI 비전 분석 기반이며 공식 검사 결과를 대체하지 않습니다.
  </div>
</body>
</html>`;
}

// ── 공개 API ─────────────────────────────────────────────────────

/** HTML → PDF 변환 후 공유 창 호출 */
export async function generateAndSharePDF(result: WeldingResult): Promise<void> {
  const html = buildHtml(result);
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) throw new Error("이 기기에서는 공유 기능을 지원하지 않습니다.");
  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    dialogTitle: `${result.userName} 용접 진단 리포트`,
    UTI: "com.adobe.pdf",
  });
}

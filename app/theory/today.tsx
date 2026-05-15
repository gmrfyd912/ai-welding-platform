import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, Pressable, Platform, ActivityIndicator, ScrollView, Alert,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { getApiUrl, apiRequest } from "@/lib/query-client";

interface QuestionLite {
  id: string;
  difficulty: "easy" | "medium" | "hard";
  category: string;
  question: string;
  options: string[];
}
interface DailyResp {
  dayKey: string;
  questions: QuestionLite[];
  selections?: Record<string, number>;
}
interface AttemptResult {
  questionId: string;
  selectedIndex: number;
  correctIndex: number;
  isCorrect: boolean;
  attemptedAt: number;
  question: {
    id: string;
    difficulty: "easy" | "medium" | "hard";
    category: string;
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  };
}
interface ResultsResp {
  dayKey: string;
  score: number;
  total: number;
  attempts: AttemptResult[];
}

const DIFF_LABEL: Record<string, string> = { easy: "하", medium: "중", hard: "상" };
const DIFF_COLOR: Record<string, string> = { easy: "#00D68F", medium: "#FFB800", hard: "#FF6A1A" };
const OPT_MARK = ["①", "②", "③", "④"];

export default function TodayScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const params = useLocalSearchParams<{ mode?: string; dayKey?: string }>();
  const qc = useQueryClient();

  const isReview = params.mode === "review";
  const reviewDayKey = params.dayKey;

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  const [selections, setSelections] = useState<Record<string, number>>({});
  const [step, setStep] = useState(0);
  const [showResults, setShowResults] = useState(isReview);

  // QUIZ MODE — fetch today's questions
  const dailyQuery = useQuery<DailyResp>({
    queryKey: [`/api/theory/daily/${user?.id}`],
    enabled: !!user?.id && !isReview,
    refetchOnMount: "always",
  });

  // Hydrate the local selections map with whatever the server already has
  // so the user can resume an in-progress session after relogin.
  useEffect(() => {
    const persisted = dailyQuery.data?.selections;
    if (persisted && Object.keys(persisted).length > 0) {
      setSelections((prev) => ({ ...persisted, ...prev }));
      // Jump to the first un-answered question (or the last one if all answered)
      const qs = dailyQuery.data?.questions ?? [];
      const nextIdx = qs.findIndex((q) => persisted[q.id] === undefined);
      setStep(nextIdx === -1 ? qs.length - 1 : nextIdx);
    }
  }, [dailyQuery.data?.dayKey]);

  // REVIEW MODE — fetch saved results
  const resultsKey = `/api/theory/results/${user?.id}/${reviewDayKey || dailyQuery.data?.dayKey}`;
  const resultsQuery = useQuery<ResultsResp>({
    queryKey: [resultsKey],
    enabled: !!user?.id && (showResults || isReview),
    refetchOnMount: "always",
  });

  const submitMut = useMutation({
    mutationFn: async () => {
      if (!user?.id || !dailyQuery.data) return;
      const dayKey = dailyQuery.data.dayKey;
      // submit each
      for (const q of dailyQuery.data.questions) {
        const sel = selections[q.id];
        if (sel === undefined) continue;
        await apiRequest("POST", "/api/theory/attempts", {
          userId: user.id,
          questionId: q.id,
          selectedIndex: sel,
          dayKey,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/theory/today-status/${user?.id}`] });
      qc.invalidateQueries({ queryKey: [`/api/theory/history/${user?.id}`] });
      qc.invalidateQueries({ queryKey: [resultsKey] });
      setShowResults(true);
    },
    onError: () => Alert.alert(t("error"), t("theory_submit_error")),
  });

  const questions = dailyQuery.data?.questions ?? [];
  const currentQ = questions[step];
  const allAnswered = questions.length > 0 && questions.every((q) => selections[q.id] !== undefined);

  const onSelect = (qid: string, idx: number) => {
    Haptics.selectionAsync();
    setSelections((p) => ({ ...p, [qid]: idx }));
  };
  const goNext = () => {
    Haptics.selectionAsync();
    setStep((s) => Math.min(s + 1, questions.length - 1));
  };
  const goPrev = () => {
    Haptics.selectionAsync();
    setStep((s) => Math.max(s - 1, 0));
  };

  const onSubmit = () => {
    if (!allAnswered) {
      Alert.alert(t("error"), t("theory_must_answer_all"));
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    submitMut.mutate();
  };

  const onFinish = () => {
    Haptics.selectionAsync();
    router.back();
  };

  const onDownloadPdf = async () => {
    if (!user?.id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const url = new URL(`/api/theory/history/${user.id}`, getApiUrl()).toString();
      const res = await fetch(url);
      const data = await res.json();
      const html = buildHistoryHtml(data, user.name || user.username || "user");
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { dialogTitle: t("theory_pdf_title"), mimeType: "application/pdf" });
      } else {
        Alert.alert(t("theory_pdf_title"), uri);
      }
    } catch (e: any) {
      console.error("pdf error", e);
      Alert.alert(t("error"), String(e?.message || e));
    }
  };

  // ---------- Render ----------
  const headerEl = (
    <View style={styles.header}>
      <Pressable
        onPress={() => {
          Haptics.selectionAsync();
          router.back();
        }}
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
      >
        <Ionicons name="chevron-back" size={24} color={Colors.text} />
      </Pressable>
      <Text style={styles.headerTitle}>
        {isReview ? t("theory_review") : t("theory_today")}
      </Text>
      <Pressable
        onPress={onDownloadPdf}
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
      >
        <Ionicons name="download-outline" size={20} color={Colors.text} />
      </Pressable>
    </View>
  );

  // Loading
  if ((dailyQuery.isLoading && !isReview) || (showResults && resultsQuery.isLoading)) {
    return (
      <View style={[styles.container, { paddingTop: topPad + 8 }]}>
        {headerEl}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      </View>
    );
  }

  // RESULTS view (after submit OR review mode)
  if (showResults) {
    const r = resultsQuery.data;
    if (!r) {
      return (
        <View style={[styles.container, { paddingTop: topPad + 8 }]}>
          {headerEl}
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: Colors.textSecondary }}>{t("theory_no_data")}</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={[styles.container, { paddingTop: topPad + 8 }]}>
        {headerEl}
        <ScrollView contentContainerStyle={{ paddingBottom: bottomPad + 100 }} showsVerticalScrollIndicator={false}>
          <View style={styles.scoreCard}>
            <Text style={styles.scoreLabel}>{t("theory_score_today")}</Text>
            <Text style={styles.scoreValue}>
              <Text style={{ color: Colors.primary }}>{r.score}</Text>
              <Text style={{ color: Colors.textSecondary, fontSize: 22 }}>{` / ${r.total}`}</Text>
            </Text>
            <Text style={styles.scoreSub}>{r.dayKey}</Text>
          </View>

          {r.attempts.map((a, idx) => {
            const myCorrect = a.isCorrect;
            return (
              <View key={a.questionId} style={styles.resCard}>
                <View style={styles.resHead}>
                  <View style={[styles.diffPill, { backgroundColor: DIFF_COLOR[a.question.difficulty] + "33", borderColor: DIFF_COLOR[a.question.difficulty] }]}>
                    <Text style={[styles.diffPillText, { color: DIFF_COLOR[a.question.difficulty] }]}>
                      {DIFF_LABEL[a.question.difficulty]}
                    </Text>
                  </View>
                  <Text style={styles.resCategory}>{a.question.category}</Text>
                  <View style={[styles.verdictPill, { backgroundColor: (myCorrect ? Colors.success : Colors.danger) + "22" }]}>
                    <Ionicons
                      name={myCorrect ? "checkmark-circle" : "close-circle"}
                      size={14}
                      color={myCorrect ? Colors.success : Colors.danger}
                    />
                    <Text style={[styles.verdictText, { color: myCorrect ? Colors.success : Colors.danger }]}>
                      {myCorrect ? t("theory_correct") : t("theory_wrong")}
                    </Text>
                  </View>
                </View>

                <Text style={styles.resQ}>
                  <Text style={{ color: Colors.primary }}>Q{idx + 1}. </Text>
                  {a.question.question}
                </Text>

                {a.question.options.map((opt, i) => {
                  const isMine = i === a.selectedIndex;
                  const isCorr = i === a.correctIndex;
                  let bg = Colors.surface;
                  let border = Colors.border;
                  if (isCorr) { bg = Colors.success + "22"; border = Colors.success; }
                  if (isMine && !isCorr) { bg = Colors.danger + "22"; border = Colors.danger; }
                  return (
                    <View key={i} style={[styles.optRow, { backgroundColor: bg, borderColor: border }]}>
                      <Text style={[styles.optMark, isCorr && { color: Colors.success }, isMine && !isCorr && { color: Colors.danger }]}>{OPT_MARK[i]}</Text>
                      <Text style={[styles.optText, isCorr && { color: Colors.success }, isMine && !isCorr && { color: Colors.danger }]}>{opt}</Text>
                      {isMine && (
                        <Text style={styles.optTag}>{t("theory_my_answer")}</Text>
                      )}
                      {isCorr && (
                        <Text style={[styles.optTag, { color: Colors.success }]}>{t("theory_correct_answer")}</Text>
                      )}
                    </View>
                  );
                })}

                <View style={styles.explainBox}>
                  <Text style={styles.explainLabel}>{t("theory_explanation")}</Text>
                  <Text style={styles.explainText}>{a.question.explanation}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: bottomPad + 12 }]}>
          <Pressable
            onPress={onFinish}
            style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.primaryBtnText}>{t("theory_finish")}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // QUIZ view
  if (!currentQ) {
    return (
      <View style={[styles.container, { paddingTop: topPad + 8 }]}>
        {headerEl}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: Colors.textSecondary }}>{t("theory_no_data")}</Text>
        </View>
      </View>
    );
  }

  const isLast = step === questions.length - 1;
  const sel = selections[currentQ.id];

  return (
    <View style={[styles.container, { paddingTop: topPad + 8 }]}>
      {headerEl}
      <View style={styles.progressBar}>
        {questions.map((q, i) => (
          <View
            key={q.id}
            style={[
              styles.progressDot,
              i === step && { backgroundColor: Colors.primary, width: 24 },
              i < step && { backgroundColor: Colors.primaryDark },
              selections[q.id] !== undefined && i !== step && { backgroundColor: Colors.success },
            ]}
          />
        ))}
        <Text style={styles.progressText}>
          {step + 1} / {questions.length}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad + 100 }} showsVerticalScrollIndicator={false}>
        <View style={styles.qHead}>
          <View style={[styles.diffPill, { backgroundColor: DIFF_COLOR[currentQ.difficulty] + "33", borderColor: DIFF_COLOR[currentQ.difficulty] }]}>
            <Text style={[styles.diffPillText, { color: DIFF_COLOR[currentQ.difficulty] }]}>
              {t("theory_difficulty")} · {DIFF_LABEL[currentQ.difficulty]}
            </Text>
          </View>
          <Text style={styles.qCategory}>{currentQ.category}</Text>
        </View>

        <Text style={styles.qText}>{currentQ.question}</Text>

        <View style={{ gap: 10, marginTop: 16 }}>
          {currentQ.options.map((opt, i) => {
            const active = sel === i;
            return (
              <Pressable
                key={i}
                onPress={() => onSelect(currentQ.id, i)}
                style={({ pressed }) => [
                  styles.choice,
                  active && styles.choiceActive,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={[styles.choiceMark, active && { color: Colors.primary }]}>{OPT_MARK[i]}</Text>
                <Text style={[styles.choiceText, active && { color: Colors.text }]}>{opt}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <View style={[styles.bottomBar, { paddingBottom: bottomPad + 12 }]}>
        <Pressable
          onPress={goPrev}
          disabled={step === 0}
          style={({ pressed }) => [
            styles.secondaryBtn,
            step === 0 && { opacity: 0.4 },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Ionicons name="chevron-back" size={18} color={Colors.text} />
          <Text style={styles.secondaryBtnText}>{t("back")}</Text>
        </Pressable>

        {!isLast ? (
          <Pressable
            onPress={goNext}
            disabled={sel === undefined}
            style={({ pressed }) => [
              styles.primaryBtn, { flex: 1.5 },
              sel === undefined && { opacity: 0.5 },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.primaryBtnText}>{t("theory_next")}</Text>
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </Pressable>
        ) : (
          <Pressable
            onPress={onSubmit}
            disabled={!allAnswered || submitMut.isPending}
            style={({ pressed }) => [
              styles.primaryBtn, { flex: 1.5, backgroundColor: Colors.success },
              (!allAnswered || submitMut.isPending) && { opacity: 0.5 },
              pressed && { opacity: 0.85 },
            ]}
          >
            {submitMut.isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={18} color="#fff" />
                <Text style={styles.primaryBtnText}>{t("theory_submit")}</Text>
              </>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildHistoryHtml(history: any, userName: string): string {
  const days = Object.keys(history.byDay || {}).sort();
  const opts = ["①", "②", "③", "④"];
  const diffMap: Record<string, string> = { easy: "하", medium: "중", hard: "상" };

  let questionsHtml = "";
  let answersHtml = "";

  let qNum = 1;
  for (const day of days) {
    questionsHtml += `<h3 class="day">📅 ${day}</h3>`;
    answersHtml += `<h3 class="day">📅 ${day}</h3>`;
    const items = history.byDay[day] || [];
    items.sort((a: any, b: any) => {
      const order: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
      return order[a.difficulty] - order[b.difficulty];
    });
    for (const a of items) {
      if (!a.question) continue;
      const q = a.question;
      questionsHtml += `
        <div class="q">
          <div class="qhead">
            <span class="diff diff-${q.difficulty}">난이도 ${diffMap[q.difficulty]}</span>
            <span class="cat">${escapeHtml(q.category)}</span>
          </div>
          <div class="qtext"><b>${qNum}.</b> ${escapeHtml(q.question)}</div>
          <ul class="opts">
            ${q.options.map((o: string, i: number) => `<li><b>${opts[i]}</b> ${escapeHtml(o)}</li>`).join("")}
          </ul>
        </div>`;

      answersHtml += `
        <div class="a">
          <div class="atitle"><b>${qNum}.</b> 정답: <b>${opts[q.correctIndex]}</b> ${escapeHtml(q.options[q.correctIndex])}</div>
          <div class="myans">내 답: <b>${opts[a.selectedIndex]}</b> · ${a.isCorrect ? '<span class="ok">정답</span>' : '<span class="ng">오답</span>'}</div>
          <div class="exp"><b>해설:</b> ${escapeHtml(q.explanation)}</div>
        </div>`;
      qNum++;
    }
  }

  const correctRate = history.totalAttempted > 0 ? Math.round((history.totalCorrect / history.totalAttempted) * 100) : 0;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Helvetica Neue", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; padding: 28px; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #0E2D54; }
  .meta { color: #666; font-size: 12px; margin-bottom: 18px; }
  .summary { background: #f0f6ff; border: 1px solid #c8def5; padding: 14px 16px; border-radius: 10px; margin-bottom: 24px; font-size: 13px; }
  .section { margin-top: 24px; padding-top: 18px; border-top: 3px solid #0E2D54; }
  .section h2 { color: #0E2D54; font-size: 18px; }
  .day { margin-top: 20px; color: #00529b; font-size: 14px; padding-bottom: 4px; border-bottom: 1px dashed #c8def5; }
  .q { margin: 14px 0; padding: 12px 14px; background: #fafbfc; border-radius: 8px; page-break-inside: avoid; }
  .qhead { font-size: 11px; margin-bottom: 6px; }
  .diff { display: inline-block; padding: 2px 8px; border-radius: 4px; margin-right: 6px; font-weight: 600; }
  .diff-easy { background: #d8f5e6; color: #007a47; }
  .diff-medium { background: #fff1cd; color: #8a6500; }
  .diff-hard { background: #ffd9c8; color: #b53800; }
  .cat { color: #666; }
  .qtext { font-size: 13px; margin-bottom: 8px; }
  .opts { list-style: none; padding-left: 8px; margin: 0; font-size: 13px; }
  .opts li { padding: 3px 0; }
  .a { margin: 12px 0; padding: 10px 14px; background: #fafbfc; border-left: 3px solid #00B4FF; font-size: 13px; page-break-inside: avoid; }
  .myans { margin-top: 4px; color: #555; }
  .ok { color: #00a36c; font-weight: 600; }
  .ng { color: #d63045; font-weight: 600; }
  .exp { margin-top: 6px; color: #444; }
  .pagebreak { page-break-before: always; }
</style></head>
<body>
<h1>이론학습 이력 — ${escapeHtml(userName)}</h1>
<div class="meta">생성일: ${new Date().toLocaleString("ko-KR")}</div>
<div class="summary">
  <b>총 풀이:</b> ${history.totalAttempted}문제 &nbsp;·&nbsp;
  <b>정답:</b> ${history.totalCorrect}문제 &nbsp;·&nbsp;
  <b>정답률:</b> ${correctRate}%
</div>

<div class="section">
  <h2>📝 문제</h2>
  ${questionsHtml || "<p>저장된 문제가 없습니다.</p>"}
</div>

<div class="pagebreak"></div>

<div class="section">
  <h2>✅ 정답 및 해설</h2>
  ${answersHtml || "<p>저장된 풀이가 없습니다.</p>"}
</div>
</body></html>`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg, paddingHorizontal: 18 },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 12,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center", backgroundColor: Colors.card,
  },
  headerTitle: {
    color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18,
  },
  progressBar: {
    flexDirection: "row", alignItems: "center", gap: 6,
    marginBottom: 18, paddingHorizontal: 4,
  },
  progressDot: {
    width: 10, height: 6, borderRadius: 3, backgroundColor: Colors.border,
  },
  progressText: {
    marginLeft: "auto", color: Colors.textSecondary, fontSize: 12, fontFamily: "Inter_500Medium",
  },
  qHead: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12,
  },
  diffPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1,
  },
  diffPillText: {
    fontSize: 11, fontFamily: "Inter_700Bold",
  },
  qCategory: {
    color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 12, flex: 1,
  },
  qText: {
    color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 17, lineHeight: 26,
  },
  choice: {
    flexDirection: "row", alignItems: "flex-start", gap: 12,
    backgroundColor: Colors.surface, borderColor: Colors.border, borderWidth: 1,
    padding: 14, borderRadius: 12,
  },
  choiceActive: {
    backgroundColor: Colors.primary + "22", borderColor: Colors.primary,
  },
  choiceMark: {
    color: Colors.textSecondary, fontFamily: "Inter_700Bold", fontSize: 16, width: 22,
  },
  choiceText: {
    color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 15, flex: 1, lineHeight: 22,
  },
  bottomBar: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    flexDirection: "row", gap: 10, paddingHorizontal: 18, paddingTop: 10,
    backgroundColor: Colors.bg,
    borderTopColor: Colors.border, borderTopWidth: 1,
  },
  primaryBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: 14,
  },
  primaryBtnText: {
    color: "#fff", fontFamily: "Inter_700Bold", fontSize: 15,
  },
  secondaryBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 4, backgroundColor: Colors.card, paddingVertical: 14, borderRadius: 14,
    borderColor: Colors.border, borderWidth: 1,
  },
  secondaryBtnText: {
    color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 14,
  },
  scoreCard: {
    backgroundColor: Colors.card, padding: 22, borderRadius: 18,
    alignItems: "center", marginBottom: 18, borderColor: Colors.border, borderWidth: 1,
  },
  scoreLabel: {
    color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 13,
  },
  scoreValue: {
    fontFamily: "Inter_700Bold", fontSize: 38, marginTop: 6,
  },
  scoreSub: {
    color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 4,
  },
  resCard: {
    backgroundColor: Colors.card, padding: 16, borderRadius: 16,
    marginBottom: 14, borderColor: Colors.border, borderWidth: 1,
  },
  resHead: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10,
  },
  resCategory: {
    color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 11, flex: 1,
  },
  verdictPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
  },
  verdictText: {
    fontSize: 11, fontFamily: "Inter_700Bold",
  },
  resQ: {
    color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 15, lineHeight: 22, marginBottom: 12,
  },
  optRow: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    padding: 10, borderRadius: 10, borderWidth: 1, marginBottom: 6,
  },
  optMark: {
    color: Colors.textSecondary, fontFamily: "Inter_700Bold", fontSize: 14, width: 18,
  },
  optText: {
    color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 13, flex: 1, lineHeight: 19,
  },
  optTag: {
    color: Colors.danger, fontFamily: "Inter_700Bold", fontSize: 10,
  },
  explainBox: {
    marginTop: 10, padding: 12, backgroundColor: Colors.surface, borderRadius: 10,
    borderLeftWidth: 3, borderLeftColor: Colors.primary,
  },
  explainLabel: {
    color: Colors.primary, fontFamily: "Inter_700Bold", fontSize: 11, marginBottom: 4,
  },
  explainText: {
    color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 20,
  },
});

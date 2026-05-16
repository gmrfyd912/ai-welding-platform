import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  ScrollView,
  Image,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import { useWelding } from "@/context/WeldingContext";
import { getApiUrl } from "@/lib/query-client";

function calcProgress(enrollDate?: string, graduateDate?: string): number {
  if (!enrollDate || !graduateDate) return 0;
  const today = new Date();
  const enroll = new Date(enrollDate);
  const graduate = new Date(graduateDate);
  const total = graduate.getTime() - enroll.getTime();
  if (total <= 0) return 0;
  const elapsed = today.getTime() - enroll.getTime();
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

function fmtDate(d?: string) {
  if (!d) return "-";
  return d.replace(/-/g, ".");
}

function calcDday(graduateDate?: string): string {
  if (!graduateDate) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const grad = new Date(graduateDate);
  grad.setHours(0, 0, 0, 0);
  const diff = Math.round((grad.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "D-Day";
  if (diff > 0) return `D-${diff}`;
  return `D+${Math.abs(diff)}`;
}

interface CourseProgress {
  courseName: string;
  enrollDate: string;
  graduateDate: string;
  studentCount: number;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { t } = useLanguage();
  const { getUserResults } = useWelding();
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [courseList, setCourseList] = useState<CourseProgress[]>([]);

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;
  const isTrainee = user?.role === "교육생";
  const isStaff = user?.role === "교사" || user?.role === "관리자";

  const checkHealth = useCallback(async () => {
    try {
      const url = new URL("/api/health", getApiUrl()).toString();
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      setIsOnline(res.ok);
    } catch {
      setIsOnline(false);
    }
  }, []);

  const loadCourses = useCallback(async () => {
    if (!isStaff) return;
    try {
      const url = new URL("/api/auth/courses/progress", getApiUrl()).toString();
      const res = await fetch(url);
      if (res.ok) setCourseList(await res.json());
    } catch {}
  }, [isStaff]);

  useEffect(() => {
    checkHealth();
    loadCourses();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth, loadCourses]);

  const progress = isTrainee ? calcProgress(user?.enrollDate, user?.graduateDate) : 0;
  const dday = isTrainee ? calcDday(user?.graduateDate) : "";
  const myResults = user ? getUserResults(user.id) : [];

  const handleDiagnosis = () => {
    Haptics.selectionAsync();
    if (isTrainee) {
      if (myResults.length === 0) {
        router.push("/(tabs)");
      } else {
        const latest = [...myResults].sort((a, b) => b.timestamp - a.timestamp)[0];
        router.push({ pathname: "/diagnosis/[id]", params: { id: latest.id } });
      }
    } else {
      router.push("/(tabs)");
    }
  };

  const handleProgress = () => {
    Haptics.selectionAsync();
    if (isStaff) {
      router.push("/(tabs)/members");
    }
  };

  return (
    <View style={[styles.container, { paddingTop: topPad + 8 }]}>
      <LinearGradient colors={["#0D1528", "#0A0E1A", "#080C18"]} style={StyleSheet.absoluteFill} />

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: bottomPad + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* 헤더 */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {user?.profilePhotoUri ? (
              <Image source={{ uri: user.profilePhotoUri }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarText}>{(user?.name ?? "?")[0]}</Text>
              </View>
            )}
            <View>
              <Text style={styles.greeting}>안녕하세요 👋</Text>
              <Text style={styles.userName} numberOfLines={1}>
                {user?.name ?? user?.username}
                <Text style={styles.roleTag}> {user?.role}</Text>
              </Text>
            </View>
          </View>
          <Pressable
            onPress={async () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              await logout();
              router.replace("/login");
            }}
            style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="log-out-outline" size={20} color={Colors.textSecondary} />
          </Pressable>
        </View>

        {/* AI 상태바 */}
        <Pressable style={styles.statusBar} onPress={checkHealth}>
          <View style={[styles.statusDot, {
            backgroundColor: isOnline === null ? "#f59e0b" : isOnline ? "#10b981" : "#ef4444"
          }]} />
          <Text style={styles.statusText}>
            {isOnline === null
              ? "AI 시스템 연결 확인 중..."
              : isOnline
              ? "AI 분석 시스템 정상 작동 중"
              : "AI 시스템 오프라인 · 탭하여 재연결"}
          </Text>
          <View style={[styles.statusBadge, {
            borderColor: isOnline === null ? "#f59e0b" : isOnline ? "#10b981" : "#ef4444"
          }]}>
            <Text style={[styles.statusBadgeText, {
              color: isOnline === null ? "#f59e0b" : isOnline ? "#10b981" : "#ef4444"
            }]}>
              {isOnline === null ? "..." : isOnline ? "ONLINE" : "OFFLINE"}
            </Text>
          </View>
        </Pressable>

        {/* 학습 메뉴 */}
        <Text style={styles.sectionTitle}>학습 메뉴</Text>
        <View style={styles.mainCards}>
          <Pressable
            onPress={() => { Haptics.selectionAsync(); router.push("/theory"); }}
            style={({ pressed }) => [styles.mainCard, pressed && { opacity: 0.88, transform: [{ scale: 0.98 }] }]}
          >
            <LinearGradient colors={["#1A4D8C", "#0E2D54"]} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
            <View style={styles.cardTopLine} />
            <View style={styles.cardTop}>
              <View style={styles.cardIconWrap}>
                <MaterialCommunityIcons name="book-open-page-variant" size={28} color="#fff" />
              </View>
              <View style={styles.cardArrow}>
                <Ionicons name="arrow-forward" size={14} color="rgba(255,255,255,0.7)" />
              </View>
            </View>
            <View>
              <Text style={styles.cardTitle}>{t("home_theory")}</Text>
              <Text style={styles.cardDesc}>용접 원리 · 재료 · 안전 규정</Text>
            </View>
          </Pressable>

          <Pressable
            onPress={() => { Haptics.selectionAsync(); router.push("/(tabs)"); }}
            style={({ pressed }) => [styles.mainCard, pressed && { opacity: 0.88, transform: [{ scale: 0.98 }] }]}
          >
            <LinearGradient colors={["#b94a10", "#7c2a00"]} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
            <View style={styles.cardTopLine} />
            <View style={styles.cardTop}>
              <View style={styles.cardIconWrap}>
                <MaterialCommunityIcons name="fire" size={28} color="#fff" />
              </View>
              <View style={styles.cardArrow}>
                <Ionicons name="arrow-forward" size={14} color="rgba(255,255,255,0.7)" />
              </View>
            </View>
            <View>
              <Text style={styles.cardTitle}>{t("home_skill")}</Text>
              <Text style={styles.cardDesc}>AI 코칭 · 자세 분석 · 실시간 피드백</Text>
            </View>
          </Pressable>
        </View>

        {/* 빠른 메뉴 */}
        <Text style={styles.sectionTitle}>빠른 메뉴</Text>
        <View style={styles.quickGrid}>

          {/* 진도 현황 */}
          <Pressable
            style={({ pressed }) => [styles.quickCard, pressed && { opacity: 0.8 }]}
            onPress={handleProgress}
          >
            <View style={[styles.quickIcon, { backgroundColor: "rgba(37,99,235,0.15)" }]}>
              <Ionicons name="bar-chart-outline" size={20} color="#60a5fa" />
            </View>
            <Text style={styles.quickLabel}>진도 현황</Text>
            {isTrainee ? (
              <>
                <Text style={styles.quickSub}>{user?.courseName ?? "과정"} · {dday}</Text>
                <View style={styles.progressBg}>
                  <View style={[styles.progressFill, { width: `${progress}%` as any, backgroundColor: "#2563eb" }]} />
                </View>
                <Text style={styles.progressPct}>{progress}% 완료</Text>
              </>
            ) : (
              <>
                <Text style={styles.quickSub}>담당 과정 현황</Text>
                {courseList.length === 0 ? (
                  <Text style={styles.progressPct}>등록된 과정 없음</Text>
                ) : (
                  courseList.slice(0, 2).map((c) => {
                    const pct = calcProgress(c.enrollDate, c.graduateDate);
                    return (
                      <View key={c.courseName} style={{ marginTop: 4 }}>
                        <View style={styles.courseRow}>
                          <Text style={styles.courseName}>{c.courseName}</Text>
                          <Text style={styles.coursePct}>{pct}%</Text>
                        </View>
                        <View style={styles.progressBg}>
                          <View style={[styles.progressFill, { width: `${pct}%` as any, backgroundColor: "#2563eb" }]} />
                        </View>
                      </View>
                    );
                  })
                )}
                <View style={styles.quickArrow}>
                  <Ionicons name="chevron-forward" size={14} color="#4a5e80" />
                </View>
              </>
            )}
          </Pressable>

          {/* AI 진단 */}
          <Pressable
            style={({ pressed }) => [styles.quickCard, pressed && { opacity: 0.8 }]}
            onPress={handleDiagnosis}
          >
            <View style={[styles.quickIcon, { backgroundColor: "rgba(16,185,129,0.15)" }]}>
              <Ionicons name="analytics-outline" size={20} color="#10b981" />
            </View>
            <Text style={styles.quickLabel}>AI 진단</Text>
            {isTrainee ? (
              <Text style={styles.quickSub}>
                {myResults.length > 0 ? `누적 ${myResults.length}건 분석` : "첫 분석을 시작하세요"}
              </Text>
            ) : (
              <Text style={styles.quickSub}>교육생 선택 → 리포트</Text>
            )}
            <View style={styles.quickArrow}>
              <Ionicons name="chevron-forward" size={14} color="#4a5e80" />
            </View>
          </Pressable>

          {/* 실시간 코칭 */}
          <Pressable
            style={({ pressed }) => [styles.quickCard, pressed && { opacity: 0.8 }]}
            onPress={() => { Haptics.selectionAsync(); router.push("/coaching-live"); }}
          >
            <View style={[styles.quickIcon, { backgroundColor: "rgba(249,115,22,0.15)" }]}>
              <Ionicons name="videocam-outline" size={20} color="#f97316" />
            </View>
            <Text style={styles.quickLabel}>실시간 코칭</Text>
            <Text style={styles.quickSub}>AI 라이브 분석</Text>
            <View style={styles.quickArrow}>
              <Ionicons name="chevron-forward" size={14} color="#4a5e80" />
            </View>
          </Pressable>

          {/* 평가·자격 */}
          <Pressable
            style={({ pressed }) => [styles.quickCard, pressed && { opacity: 0.8 }]}
            onPress={() => { Haptics.selectionAsync(); router.push("/exam-record"); }}
          >
            <View style={[styles.quickIcon, { backgroundColor: "rgba(139,92,246,0.15)" }]}>
              <Ionicons name="ribbon-outline" size={20} color="#8b5cf6" />
            </View>
            <Text style={styles.quickLabel}>평가 · 자격</Text>
            <Text style={styles.quickSub}>시험 기록 직접 입력</Text>
            <View style={styles.quickArrow}>
              <Ionicons name="chevron-forward" size={14} color="#4a5e80" />
            </View>
          </Pressable>

        </View>

        {/* 교육생 전용: 과정 정보 카드 */}
        {isTrainee && user?.enrollDate && user?.graduateDate && (
          <View style={styles.courseInfoCard}>
            <View style={styles.courseInfoHeader}>
              <Ionicons name="school-outline" size={16} color={Colors.primary} />
              <Text style={styles.courseInfoTitle}>{user.courseName ?? "교육 과정"} 정보</Text>
            </View>
            <View style={styles.courseInfoRow}>
              <View style={styles.courseInfoItem}>
                <Text style={styles.courseInfoLabel}>입교일</Text>
                <Text style={styles.courseInfoValue}>{fmtDate(user.enrollDate)}</Text>
              </View>
              <View style={styles.courseInfoDivider} />
              <View style={styles.courseInfoItem}>
                <Text style={styles.courseInfoLabel}>수료일</Text>
                <Text style={styles.courseInfoValue}>{fmtDate(user.graduateDate)}</Text>
              </View>
              <View style={styles.courseInfoDivider} />
              <View style={styles.courseInfoItem}>
                <Text style={styles.courseInfoLabel}>D-Day</Text>
                <Text style={[styles.courseInfoValue, { color: Colors.primary }]}>{dday}</Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0E1A" },
  scroll: { paddingHorizontal: 20, gap: 0 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  avatar: { width: 42, height: 42, borderRadius: 21, borderWidth: 2, borderColor: Colors.primary },
  avatarPlaceholder: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: Colors.primary + "33", borderWidth: 2, borderColor: Colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: Colors.primary, fontFamily: "Inter_700Bold", fontSize: 16 },
  greeting: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 12 },
  userName: { color: "#e2e8f0", fontFamily: "Inter_700Bold", fontSize: 16, marginTop: 1 },
  roleTag: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 12 },
  logoutBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.05)", borderWidth: 0.5, borderColor: "#2a3a5c",
    alignItems: "center", justifyContent: "center",
  },
  statusBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "rgba(37,99,235,0.08)", borderWidth: 0.5, borderColor: "#2563eb",
    borderRadius: 12, padding: 10, marginBottom: 18,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  statusText: { color: "#60a5fa", fontFamily: "Inter_400Regular", fontSize: 11, flex: 1 },
  statusBadge: { borderWidth: 0.5, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  statusBadgeText: { fontFamily: "Inter_600SemiBold", fontSize: 9, letterSpacing: 1 },
  sectionTitle: {
    color: "#4a5e80", fontFamily: "Inter_600SemiBold", fontSize: 10,
    letterSpacing: 2, textTransform: "uppercase", marginBottom: 10,
  },
  mainCards: { flexDirection: "row", gap: 10, marginBottom: 18 },
  mainCard: { flex: 1, borderRadius: 18, padding: 16, overflow: "hidden", minHeight: 140, justifyContent: "space-between" },
  cardTopLine: { position: "absolute", top: 0, left: 0, right: 0, height: 2, backgroundColor: "rgba(255,255,255,0.25)" },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  cardIconWrap: { width: 50, height: 50, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" },
  cardArrow: { width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" },
  cardTitle: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 18, marginTop: 10 },
  cardDesc: { color: "rgba(255,255,255,0.65)", fontFamily: "Inter_400Regular", fontSize: 10, marginTop: 2 },
  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 18 },
  quickCard: {
    width: "47.5%", backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 0.5, borderColor: "#2a3a5c", borderRadius: 14, padding: 14, gap: 6,
  },
  quickIcon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  quickLabel: { color: "#e2e8f0", fontFamily: "Inter_600SemiBold", fontSize: 13 },
  quickSub: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 10 },
  quickArrow: { alignSelf: "flex-end", marginTop: 4 },
  progressBg: { height: 3, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 2, marginTop: 2 },
  progressFill: { height: 3, borderRadius: 2 },
  progressPct: { color: "#60a5fa", fontFamily: "Inter_600SemiBold", fontSize: 11 },
  courseRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  courseName: { color: "#7a8aaa", fontFamily: "Inter_400Regular", fontSize: 10 },
  coursePct: { color: "#60a5fa", fontFamily: "Inter_600SemiBold", fontSize: 10 },
  courseInfoCard: {
    backgroundColor: "rgba(255,255,255,0.04)", borderWidth: 0.5,
    borderColor: "#2a3a5c", borderRadius: 14, padding: 14, gap: 12,
  },
  courseInfoHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  courseInfoTitle: { color: "#e2e8f0", fontFamily: "Inter_600SemiBold", fontSize: 13 },
  courseInfoRow: { flexDirection: "row", alignItems: "center" },
  courseInfoItem: { flex: 1, alignItems: "center", gap: 4 },
  courseInfoLabel: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 10 },
  courseInfoValue: { color: "#e2e8f0", fontFamily: "Inter_600SemiBold", fontSize: 13 },
  courseInfoDivider: { width: 0.5, height: 32, backgroundColor: "#2a3a5c" },
});

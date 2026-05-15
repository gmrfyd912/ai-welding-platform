import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Image,
  Platform,
  Modal,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Colors, { getGradeColor } from "@/constants/colors";
import { useWelding, WeldingResult } from "@/context/WeldingContext";
import { useLanguage } from "@/context/LanguageContext";

type RankTab = "total" | "weekly" | "daily";

interface UserRank {
  userId: string;
  userName: string;
  profileUri?: string;
  bestPhotoUri?: string;
  uploadCount: number;
  bestScore: number;
  avgScore: number;
  rank: number;
  prevRank: number;
}

// 평균점수 기준으로 userId → 순위 맵을 반환 (1위가 1)
function rankUsersByAvg(results: WeldingResult[]): Map<string, number> {
  const sums = new Map<string, { sum: number; count: number }>();
  results.forEach((r) => {
    const cur = sums.get(r.userId) ?? { sum: 0, count: 0 };
    cur.sum += r.aiScore;
    cur.count += 1;
    sums.set(r.userId, cur);
  });
  const arr: { userId: string; avg: number }[] = [];
  sums.forEach((v, userId) => arr.push({ userId, avg: v.sum / v.count }));
  arr.sort((a, b) => b.avg - a.avg);
  const out = new Map<string, number>();
  arr.forEach((u, i) => out.set(u.userId, i + 1));
  return out;
}

// prevRank 의 -1 은 "이전 기간에 기록 없음 = NEW 진입자" 의미.
// (RankChange / topRiser / topFaller 모두 이 sentinel 을 감지해 처리)
function computeRanks(results: WeldingResult[], tab: RankTab): UserRank[] {
  const now = Date.now();
  const dayMs = 86400000;
  const weekMs = 7 * dayMs;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartTs = dayStart.getTime();
  const dayEndTs = dayStartTs + dayMs;
  const yesterdayStartTs = dayStartTs - dayMs;

  // 탭별로 현재/이전 기간을 정의 — 두 기간 각각 랭킹해서 변동 계산
  // - 전체: 현재 = 전체 누적 / 이전 = 어제 0시 이전 누적 (오늘 추가분으로 인한 순위 변동)
  // - 주간: 현재 = 최근 7일      / 이전 = 그 직전 7일 (8~14일 전)
  // - 오늘: 현재 = 오늘           / 이전 = 어제
  let currentFilter: (r: WeldingResult) => boolean;
  let previousFilter: (r: WeldingResult) => boolean;
  if (tab === "weekly") {
    currentFilter  = (r) => now - r.timestamp <= weekMs;
    previousFilter = (r) => {
      const age = now - r.timestamp;
      return age > weekMs && age <= 2 * weekMs;
    };
  } else if (tab === "daily") {
    currentFilter  = (r) => r.timestamp >= dayStartTs && r.timestamp < dayEndTs;
    previousFilter = (r) => r.timestamp >= yesterdayStartTs && r.timestamp < dayStartTs;
  } else {
    currentFilter  = () => true;
    previousFilter = (r) => r.timestamp < dayStartTs;
  }

  const current = results.filter(currentFilter);
  const prevRankMap = rankUsersByAvg(results.filter(previousFilter));

  const userMap = new Map<string, { results: WeldingResult[]; name: string; profileUri?: string }>();
  current.forEach((r) => {
    if (!userMap.has(r.userId)) {
      userMap.set(r.userId, { results: [], name: r.userName, profileUri: r.userProfileUri });
    }
    userMap.get(r.userId)!.results.push(r);
  });

  const ranks: Omit<UserRank, "rank" | "prevRank">[] = [];
  userMap.forEach((data, userId) => {
    const scores = data.results.map((r) => r.aiScore);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const bestScore = Math.max(...scores);
    const bestResult = data.results.find((r) => r.aiScore === bestScore);
    ranks.push({
      userId,
      userName: data.name,
      profileUri: data.profileUri,
      bestPhotoUri: bestResult?.photoUri,
      uploadCount: data.results.length,
      bestScore,
      avgScore: Math.round(avgScore * 10) / 10,
    });
  });

  ranks.sort((a, b) => b.avgScore - a.avgScore);

  return ranks.map((r, i) => {
    const prev = prevRankMap.get(r.userId);
    return {
      ...r,
      rank: i + 1,
      prevRank: prev !== undefined ? prev : -1,  // -1 = 이전 기간 기록 없음 (NEW)
    };
  });
}

function RankChange({ rank, prevRank }: { rank: number; prevRank: number }) {
  // 이전 기간 기록이 없는 신규 진입자
  if (prevRank === -1) {
    return (
      <View style={{
        paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
        backgroundColor: Colors.primary + "22",
      }}>
        <Text style={{ color: Colors.primary, fontSize: 9, fontFamily: "Inter_700Bold" }}>NEW</Text>
      </View>
    );
  }
  const diff = prevRank - rank;
  if (diff === 0) {
    return <Ionicons name="remove" size={14} color={Colors.textMuted} />;
  }
  if (diff > 0) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Ionicons name="caret-up" size={12} color={Colors.success} />
        <Text style={{ color: Colors.success, fontSize: 10, fontFamily: "Inter_600SemiBold" }}>{diff}</Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Ionicons name="caret-down" size={12} color={Colors.danger} />
      <Text style={{ color: Colors.danger, fontSize: 10, fontFamily: "Inter_600SemiBold" }}>{Math.abs(diff)}</Text>
    </View>
  );
}

function RankCard({ item, index, onPress, tFn }: { item: UserRank; index: number; onPress: () => void; tFn: (k: string) => string }) {
  const isFirst = item.rank === 1;
  const rankColors = [Colors.gold, Colors.silver, Colors.bronze];
  const rankColor = item.rank <= 3 ? rankColors[item.rank - 1] : Colors.textMuted;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.rankCard,
        isFirst && styles.rankCardFirst,
        pressed && { opacity: 0.85 },
      ]}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
    >
      {isFirst && (
        <LinearGradient
          colors={[Colors.gold + "22", Colors.card]}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
        />
      )}

      <View style={styles.rankLeft}>
        <View style={[styles.rankNumContainer, { borderColor: rankColor }]}>
          {item.rank <= 3 ? (
            <MaterialCommunityIcons
              name={item.rank === 1 ? "trophy" : "medal"}
              size={18}
              color={rankColor}
            />
          ) : (
            <Text style={[styles.rankNum, { color: rankColor }]}>{item.rank}</Text>
          )}
        </View>
        <RankChange rank={item.rank} prevRank={item.prevRank} />
      </View>

      <View style={styles.rankPhoto}>
        {item.bestPhotoUri ? (
          <Image source={{ uri: item.bestPhotoUri }} style={styles.rankPhotoImg} />
        ) : (
          <View style={[styles.rankPhotoImg, styles.rankPhotoPlaceholder]}>
            <MaterialCommunityIcons name="image-off-outline" size={18} color={Colors.textMuted} />
          </View>
        )}
      </View>

      <View style={styles.rankInfo}>
        <View style={styles.rankInfoTop}>
          {item.profileUri && (item.profileUri.startsWith("data:") || item.profileUri.startsWith("http")) ? (
            <Image source={{ uri: item.profileUri }} style={styles.rankAvatar} />
          ) : (
            <View style={[styles.rankAvatar, styles.rankAvatarPlaceholder]}>
              <Ionicons name="person" size={14} color={Colors.textMuted} />
            </View>
          )}
          <Text style={styles.rankName}>{item.userName}</Text>
        </View>
        <View style={styles.rankStats}>
          <Text style={styles.rankStatLabel}>{tFn("rank_upload")} <Text style={styles.rankStatVal}>{item.uploadCount}</Text></Text>
          <Text style={styles.rankStatLabel}>{tFn("rank_best")} <Text style={[styles.rankStatVal, { color: getGradeColor(item.bestScore) }]}>{item.bestScore}</Text></Text>
        </View>
      </View>

      <View style={styles.rankScore}>
        <Text style={[styles.rankAvgScore, { color: getGradeColor(item.avgScore) }]}>
          {item.avgScore.toFixed(1)}
        </Text>
        <Text style={styles.rankAvgLabel}>{tFn("rank_avg")}</Text>
      </View>
    </Pressable>
  );
}

export default function RankingScreen() {
  const insets = useSafeAreaInsets();
  const { results } = useWelding();

  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<RankTab>("total");
  const [selectedCourse, setSelectedCourse] = useState("전체");
  const [showCourseModal, setShowCourseModal] = useState(false);

  const TABS: { key: RankTab; label: string }[] = [
    { key: "total", label: t("rank_total") },
    { key: "weekly", label: t("rank_weekly") },
    { key: "daily", label: t("rank_daily") },
  ];

  const courseNames = useMemo(() => {
    const names = new Set<string>();
    results.forEach((r) => { if (r.userCourseName) names.add(r.userCourseName); });
    return ["전체", ...Array.from(names).sort()];
  }, [results]);

  const filteredResults = useMemo(() => {
    if (selectedCourse === "전체") return results;
    return results.filter((r) => r.userCourseName === selectedCourse);
  }, [results, selectedCourse]);

  const ranks = useMemo(() => computeRanks(filteredResults, activeTab), [filteredResults, activeTab]);

  // 이전 기간 기록이 있는 사용자만(=prevRank > 0) 상승/하락 비교 대상
  const topRiser = useMemo(() => {
    const eligible = ranks.filter((r) => r.prevRank > 0 && r.prevRank - r.rank > 0);
    if (eligible.length === 0) return null;
    return eligible.reduce((best, r) =>
      (r.prevRank - r.rank) > (best.prevRank - best.rank) ? r : best
    , eligible[0]);
  }, [ranks]);

  const topFaller = useMemo(() => {
    const eligible = ranks.filter((r) => r.prevRank > 0 && r.prevRank - r.rank < 0);
    if (eligible.length === 0) return null;
    return eligible.reduce((worst, r) =>
      (r.prevRank - r.rank) < (worst.prevRank - worst.rank) ? r : worst
    , eligible[0]);
  }, [ranks]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const ListHeader = () => (
    <View>
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <View>
          <Text style={styles.headerTitle}>{t("rank_title")}</Text>
          <Text style={styles.headerSubtitle}>{t("rank_subtitle")}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {courseNames.length > 1 && (
            <Pressable
              style={styles.courseFilterBtn}
              onPress={() => { Haptics.selectionAsync(); setShowCourseModal(true); }}
            >
              <MaterialCommunityIcons name="book-education-outline" size={13} color={Colors.primary} />
              <Text style={styles.courseFilterText} numberOfLines={1}>{selectedCourse}</Text>
              <Ionicons name="chevron-down" size={12} color={Colors.primary} />
            </Pressable>
          )}
          <Pressable
            style={styles.addBtn}
            onPress={() => router.push("/register-photo")}
          >
            <LinearGradient colors={[Colors.primary, Colors.primaryDark]} style={styles.addBtnGrad}>
              <Ionicons name="add" size={22} color="#fff" />
            </LinearGradient>
          </Pressable>
        </View>
      </View>

      {ranks.length > 0 && (topRiser || topFaller) && (
        <View style={styles.highlightRow}>
          {topRiser && (topRiser.prevRank - topRiser.rank) > 0 && (
            <View style={[styles.highlightCard, { borderColor: Colors.success + "55" }]}>
              <LinearGradient colors={[Colors.success + "22", "transparent"]} style={StyleSheet.absoluteFill} />
              <Ionicons name="trending-up" size={16} color={Colors.success} />
              <View>
                <Text style={styles.highlightLabel}>{t("rank_topRiser")}</Text>
                <Text style={styles.highlightName}>{topRiser.userName}</Text>
              </View>
              <Text style={[styles.highlightDiff, { color: Colors.success }]}>
                +{topRiser.prevRank - topRiser.rank}
              </Text>
            </View>
          )}
          {topFaller && topFaller.rank !== topRiser?.rank && (topFaller.prevRank - topFaller.rank) < 0 && (
            <View style={[styles.highlightCard, { borderColor: Colors.danger + "55" }]}>
              <LinearGradient colors={[Colors.danger + "22", "transparent"]} style={StyleSheet.absoluteFill} />
              <Ionicons name="trending-down" size={16} color={Colors.danger} />
              <View>
                <Text style={styles.highlightLabel}>{t("rank_topFaller")}</Text>
                <Text style={styles.highlightName}>{topFaller.userName}</Text>
              </View>
              <Text style={[styles.highlightDiff, { color: Colors.danger }]}>
                {topFaller.prevRank - topFaller.rank}
              </Text>
            </View>
          )}
        </View>
      )}

      {ranks.length > 0 && (
        <View style={styles.firstBanner}>
          <LinearGradient colors={[Colors.gold + "33", "transparent"]} style={StyleSheet.absoluteFill} />
          <MaterialCommunityIcons name="trophy" size={18} color={Colors.gold} />
          <Text style={styles.firstBannerText}>
            현재 1위: <Text style={{ color: Colors.gold }}>{ranks[0]?.userName}</Text>
            {" "}(평균 {ranks[0]?.avgScore}점)
          </Text>
        </View>
      )}

      <View style={styles.tabRow}>
        {TABS.map(({ key, label }) => (
          <Pressable
            key={key}
            style={[styles.tabChip, activeTab === key && styles.tabChipActive]}
            onPress={() => { setActiveTab(key); Haptics.selectionAsync(); }}
          >
            <Text style={[styles.tabChipText, activeTab === key && styles.tabChipTextActive]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );

  const EmptyState = () => (
    <View style={styles.emptyState}>
      <MaterialCommunityIcons name="chart-bar-stacked" size={52} color={Colors.textMuted} />
      <Text style={styles.emptyTitle}>
        {t("rank_empty")}
      </Text>
      <Text style={styles.emptyText}>{t("rank_noData")}</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <LinearGradient colors={[Colors.bg, "#0D1528", Colors.bg]} style={StyleSheet.absoluteFill} />
      <FlatList
        data={ranks}
        keyExtractor={(item) => item.userId}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 100 }]}
        ListHeaderComponent={<ListHeader />}
        ListEmptyComponent={<EmptyState />}
        renderItem={({ item, index }) => (
          <RankCard
            item={item}
            index={index}
            tFn={t}
            onPress={() => {
              const userResults = filteredResults.filter((r) => r.userId === item.userId);
              if (userResults.length > 0) {
                router.push({ pathname: "/diagnosis/[id]", params: { id: userResults[0].id } });
              }
            }}
          />
        )}
        showsVerticalScrollIndicator={false}
      />

      <Modal visible={showCourseModal} transparent animationType="fade" onRequestClose={() => setShowCourseModal(false)}>
        <Pressable style={styles.courseModalOverlay} onPress={() => setShowCourseModal(false)}>
          <View style={styles.courseModal}>
            <Text style={styles.courseModalTitle}>과정 선택</Text>
            {courseNames.map((name) => {
              const isSelected = name === selectedCourse;
              return (
                <Pressable
                  key={name}
                  style={[styles.courseModalItem, isSelected && styles.courseModalItemSelected]}
                  onPress={() => { setSelectedCourse(name); setShowCourseModal(false); Haptics.selectionAsync(); }}
                >
                  <Text style={[styles.courseModalItemText, isSelected && { color: Colors.primary }]}>{name}</Text>
                  {isSelected && <Ionicons name="checkmark-circle" size={16} color={Colors.primary} />}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  headerTitle: {
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginTop: 2,
  },
  addBtn: { borderRadius: 18, overflow: "hidden" },
  addBtnGrad: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  highlightRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  highlightCard: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    overflow: "hidden",
  },
  highlightLabel: { color: Colors.textMuted, fontSize: 10, fontFamily: "Inter_400Regular" },
  highlightName: { color: Colors.text, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  highlightDiff: { fontFamily: "Inter_700Bold", fontSize: 18, marginLeft: "auto" },
  firstBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 14,
    backgroundColor: Colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.gold + "44",
    padding: 10,
    overflow: "hidden",
  },
  firstBannerText: {
    color: Colors.text,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  tabRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  tabChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
  },
  tabChipActive: {
    backgroundColor: Colors.primary + "22",
    borderColor: Colors.primary,
  },
  tabChipText: {
    color: Colors.textSecondary,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  tabChipTextActive: { color: Colors.primary },
  listContent: { paddingHorizontal: 16 },
  rankCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    marginBottom: 10,
    overflow: "hidden",
    gap: 10,
  },
  rankCardFirst: {
    borderColor: Colors.gold + "55",
  },
  rankLeft: {
    alignItems: "center",
    gap: 4,
    width: 36,
  },
  rankNumContainer: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  rankNum: { fontFamily: "Inter_700Bold", fontSize: 15 },
  rankPhoto: {
    width: 64,
    height: 64,
    borderRadius: 10,
    overflow: "hidden",
  },
  rankPhotoImg: { width: "100%", height: "100%" },
  rankPhotoPlaceholder: {
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  rankInfo: { flex: 1, gap: 6 },
  rankInfoTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rankAvatar: { width: 24, height: 24, borderRadius: 12 },
  rankAvatarPlaceholder: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  rankName: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 15 },
  rankStats: { flexDirection: "row", gap: 12 },
  rankStatLabel: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 12 },
  rankStatVal: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 12 },
  rankScore: { alignItems: "flex-end" },
  rankAvgScore: { fontFamily: "Inter_700Bold", fontSize: 22 },
  rankAvgLabel: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },
  emptyState: {
    alignItems: "center",
    paddingTop: 80,
    gap: 12,
  },
  emptyTitle: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 18 },
  emptyText: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 14 },
  courseFilterBtn: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primary + "44",
    maxWidth: 130,
  },
  courseFilterText: {
    color: Colors.primary,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    flex: 1,
  },
  courseModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  courseModal: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    overflow: "hidden" as const,
    width: "100%",
    maxWidth: 320,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 8,
  },
  courseModalTitle: {
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  courseModalItem: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  courseModalItemSelected: { backgroundColor: Colors.primary + "18" },
  courseModalItemText: {
    color: Colors.text,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
});

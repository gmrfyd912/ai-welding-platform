import React from "react";
import {
  View, Text, StyleSheet, Pressable, Platform, ScrollView, ActivityIndicator,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useQuery } from "@tanstack/react-query";
import Colors from "@/constants/colors";
import { useLanguage } from "@/context/LanguageContext";
import { useAuth } from "@/context/AuthContext";

interface LeaderRow {
  rank: number;
  userId: string;
  userName: string;
  finalWave: number;
  quizCorrect: number;
  quizTotal: number;
  accuracy: number;
}

export default function OXScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuth();

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  const lbQuery = useQuery<{ leaderboard: LeaderRow[] }>({
    queryKey: ["/api/ox/leaderboard"],
    refetchOnMount: "always",
  });

  const stateQuery = useQuery<{ snapshot: any | null; updatedAt?: string }>({
    queryKey: [`/api/ox/state/${user?.id}`],
    enabled: !!user?.id,
    refetchOnMount: "always",
  });

  // 다른 화면 다녀온 뒤 돌아오면 두 쿼리 모두 새로 고침
  useFocusEffect(
    React.useCallback(() => {
      lbQuery.refetch();
      stateQuery.refetch();
    }, [user?.id])
  );

  const hasSaved = !!stateQuery.data?.snapshot;
  const board = lbQuery.data?.leaderboard ?? [];

  const onResume = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/theory/ox-game?mode=resume");
  };
  const onStart = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/theory/ox-game?mode=new");
  };

  const rankColor = (r: number) =>
    r === 1 ? Colors.gold : r === 2 ? Colors.silver : r === 3 ? Colors.bronze : Colors.textMuted;

  return (
    <View style={[styles.container, { paddingTop: topPad + 8, paddingBottom: bottomPad + 16 }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => { Haptics.selectionAsync(); router.back(); }}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("ox_title")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 12 }}>
        <View style={styles.heroCard}>
          <LinearGradient
            colors={["#3A1E5C", "#1B0E33"]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          />
          <MaterialCommunityIcons name="gamepad-variant" size={56} color="#BA55FF" />
          <Text style={styles.heroTitle}>{t("ox_hero")}</Text>
          <Text style={styles.heroDesc}>{t("ox_hero_desc")}</Text>
        </View>

        <View style={styles.rankCard}>
          <View style={styles.rankHead}>
            <MaterialCommunityIcons name="trophy" size={20} color={Colors.gold} />
            <Text style={styles.rankTitle}>{t("ox_ranking_title")}</Text>
            <Text style={styles.rankSub}>Top 10</Text>
          </View>

          {lbQuery.isLoading ? (
            <View style={styles.emptyRank}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : board.length === 0 ? (
            <View style={styles.emptyRank}>
              <MaterialCommunityIcons name="trophy-outline" size={42} color={Colors.textMuted} />
              <Text style={styles.emptyRankText}>{t("ox_ranking_empty")}</Text>
            </View>
          ) : (
            board.map((r) => {
              const isMe = user?.id && String(r.userId) === String(user.id);
              return (
                <View key={`${r.userId}-${r.rank}`} style={[styles.rankRow, isMe && styles.rankRowMe]}>
                  <View style={[styles.rankBadge, { backgroundColor: rankColor(r.rank) + "22", borderColor: rankColor(r.rank) }]}>
                    <Text style={[styles.rankNum, { color: rankColor(r.rank) }]}>{r.rank}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rankName} numberOfLines={1}>
                      {r.userName}{isMe ? "  (나)" : ""}
                    </Text>
                    <Text style={styles.rankAccuracy}>
                      {t("ox_accuracy")} {r.accuracy}%  ·  {r.quizCorrect}/{r.quizTotal}
                    </Text>
                  </View>
                  <Text style={styles.rankWave}>Wave {r.finalWave}</Text>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      {hasSaved && (
        <Pressable
          onPress={onResume}
          style={({ pressed }) => [styles.resumeBtn, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="play-circle" size={22} color="#fff" />
          <Text style={styles.resumeText}>{t("ox_resume")}</Text>
          <Text style={styles.resumeSub}>Wave {stateQuery.data?.snapshot?.gameState?.wave ?? "—"}</Text>
        </Pressable>
      )}

      <Pressable
        onPress={onStart}
        style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.85 }]}
      >
        <LinearGradient
          colors={["#BA55FF", "#7A1FCC"]}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        />
        <Ionicons name="play" size={22} color="#fff" />
        <Text style={styles.startText}>{hasSaved ? t("ox_start_new") : t("ox_start")}</Text>
      </Pressable>
    </View>
  );
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
  headerTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18 },
  heroCard: {
    borderRadius: 20, padding: 22, overflow: "hidden",
    alignItems: "center", marginBottom: 14,
  },
  heroTitle: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 22, marginTop: 10 },
  heroDesc: {
    color: "rgba(255,255,255,0.78)", fontFamily: "Inter_400Regular", fontSize: 13,
    textAlign: "center", marginTop: 6,
  },
  rankCard: {
    backgroundColor: Colors.card, borderRadius: 18, padding: 16,
    borderColor: Colors.border, borderWidth: 1,
  },
  rankHead: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8,
  },
  rankTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 16, flex: 1 },
  rankSub: { color: Colors.textMuted, fontFamily: "Inter_500Medium", fontSize: 11 },
  emptyRank: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 30 },
  emptyRankText: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13 },
  rankRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 10, borderBottomColor: Colors.border, borderBottomWidth: 1, gap: 10,
  },
  rankRowMe: { backgroundColor: Colors.primary + "11", borderRadius: 8, paddingHorizontal: 6 },
  rankBadge: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: "center", justifyContent: "center", borderWidth: 1,
  },
  rankNum: { fontFamily: "Inter_700Bold", fontSize: 13 },
  rankName: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 14 },
  rankAccuracy: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 11, marginTop: 2 },
  rankWave: { color: Colors.primary, fontFamily: "Inter_700Bold", fontSize: 14 },

  resumeBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 14, borderRadius: 14, marginTop: 10, backgroundColor: Colors.success,
  },
  resumeText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16 },
  resumeSub: { color: "rgba(255,255,255,0.85)", fontFamily: "Inter_500Medium", fontSize: 12, marginLeft: 6 },

  startBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 16, borderRadius: 16, marginTop: 10, overflow: "hidden",
  },
  startText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16 },
});

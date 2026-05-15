import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Image,
  RefreshControl,
  Platform,
  Alert,
  Modal,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useQuery } from "@tanstack/react-query";
import { getApiUrl } from "@/lib/query-client";
import Colors, { getGradeColor, getGrade } from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useWelding, WeldingResult } from "@/context/WeldingContext";
import { useLanguage } from "@/context/LanguageContext";


function GradeBadge({ score }: { score: number }) {
  const grade = getGrade(score);
  const color = getGradeColor(score);
  return (
    <View style={[styles.gradeBadge, { backgroundColor: color + "DD" }]}>
      <Text style={styles.gradeBadgeText}>{grade}</Text>
    </View>
  );
}

function ResultCard({
  item,
  isAdmin,
  onPress,
  onDelete,
  commentCount,
}: {
  item: WeldingResult;
  isAdmin: boolean;
  onPress: () => void;
  onDelete: () => void;
  commentCount: number;
}) {
  const date = new Date(item.timestamp);
  const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
    >
      <View style={styles.cardImageContainer}>
        {(item.photos?.front ?? item.photoUri) ? (
          <Image
            source={{ uri: item.photos?.front ?? item.photoUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.cardImagePlaceholder]}>
            <MaterialCommunityIcons name="image-off-outline" size={32} color={Colors.textMuted} />
          </View>
        )}
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.7)"]}
          style={styles.cardGradient}
        />
        <GradeBadge score={item.aiScore} />
        <View style={styles.cardProcessBadge}>
          <Text style={styles.cardProcessText}>{item.process}</Text>
        </View>
        {(() => {
          const extra = (item.photos?.side ? 1 : 0) + (item.photos?.back ? 1 : 0);
          return extra > 0 ? (
            <View style={styles.extraPhotoBadge}>
              <Ionicons name="images-outline" size={10} color="#fff" />
              <Text style={styles.extraPhotoBadgeText}>+{extra}</Text>
            </View>
          ) : null;
        })()}
        {isAdmin && (
          <Pressable
            style={styles.adminDeleteBtn}
            onPress={(e) => {
              e.stopPropagation?.();
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onDelete();
            }}
          >
            <Ionicons name="trash-outline" size={13} color="#fff" />
          </Pressable>
        )}
      </View>
      <View style={styles.cardInfo}>
        <View style={styles.cardInfoRow}>
          <View style={styles.cardNameRow}>
            {item.userProfileUri && (item.userProfileUri.startsWith("data:") || item.userProfileUri.startsWith("http")) ? (
              <Image source={{ uri: item.userProfileUri }} style={styles.cardAvatar} />
            ) : (
              <View style={[styles.cardAvatar, styles.cardAvatarPlaceholder]}>
                <Ionicons name="person" size={10} color={Colors.textMuted} />
              </View>
            )}
            <Text style={styles.cardName} numberOfLines={1}>{item.userName}</Text>
            {commentCount > 0 && (
              <View style={styles.commentCountBadge}>
                <Ionicons name="chatbubble-outline" size={9} color={Colors.primary} />
                <Text style={styles.commentCountText}>{commentCount}</Text>
              </View>
            )}
          </View>
          <Text style={[styles.cardScore, { color: getGradeColor(item.aiScore) }]}>
            {item.aiScore}점
          </Text>
        </View>
        <View style={styles.cardInfoRow}>
          <Text style={styles.cardDate}>{dateStr}</Text>
          {item.userCourseName ? (
            <View style={styles.courseNameBadge}>
              <MaterialCommunityIcons name="book-education-outline" size={9} color={Colors.primary} />
              <Text style={styles.courseNameText} numberOfLines={1}>{item.userCourseName}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export default function GalleryScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { results, isLoading, refreshResults, deleteResult, migrateLocalFileUris } = useWelding();
  const { t } = useLanguage();
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState("전체");
  const [showCourseModal, setShowCourseModal] = useState(false);

  const isAdmin = user?.username === "admin";

  useEffect(() => {
    if (!isLoading && user?.id) {
      migrateLocalFileUris(user.id);
    }
  }, [isLoading, user?.id]);

  const courseNames = useMemo(() => {
    const names = new Set<string>();
    results.forEach((r) => { if (r.userCourseName) names.add(r.userCourseName); });
    return ["전체", ...Array.from(names).sort()];
  }, [results]);

  const filteredResults = useMemo(() => {
    if (selectedCourse === "전체") return results;
    return results.filter((r) => r.userCourseName === selectedCourse);
  }, [results, selectedCourse]);

  const { data: commentCounts = {} } = useQuery<Record<string, number>>({
    queryKey: ["/api/comments-count"],
    queryFn: async () => {
      const url = new URL("/api/comments-count", getApiUrl());
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 30000,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshResults();
    setRefreshing(false);
  }, [refreshResults]);

  const handleDelete = (item: WeldingResult) => {
    Alert.alert(
      t("error"),
      `${item.userName}?`,
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("done"),
          style: "destructive",
          onPress: async () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            await deleteResult(item.id);
          },
        },
      ]
    );
  };

  const handleBackToHome = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.replace("/home");
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const ListHeader = () => (
    <View>
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={styles.headerTitle}>실습 갤러리</Text>
            {isAdmin && (
              <View style={styles.adminBadge}>
                <Ionicons name="shield-checkmark" size={12} color={Colors.gold} />
                <Text style={styles.adminBadgeText}>관리자</Text>
              </View>
            )}
          </View>
          <Text style={styles.headerSubtitle}>{filteredResults.length}개의 결과물</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Pressable onPress={handleBackToHome} style={styles.iconBtn} hitSlop={6}>
            <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.addBtn}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              router.push("/register-photo");
            }}
          >
            <LinearGradient
              colors={[Colors.primary, Colors.primaryDark]}
              style={styles.addBtnGrad}
            >
              <Ionicons name="add" size={22} color="#fff" />
            </LinearGradient>
          </Pressable>
        </View>
      </View>
      {courseNames.length > 1 && (
        <Pressable
          style={styles.courseFilterBtn}
          onPress={() => { Haptics.selectionAsync(); setShowCourseModal(true); }}
        >
          <MaterialCommunityIcons name="book-education-outline" size={14} color={Colors.primary} />
          <Text style={styles.courseFilterText}>{selectedCourse}</Text>
          <Ionicons name="chevron-down" size={14} color={Colors.primary} />
        </Pressable>
      )}
    </View>
  );

  const EmptyState = () => (
    <View style={styles.emptyState}>
      <MaterialCommunityIcons name="camera-plus-outline" size={56} color={Colors.textMuted} />
      <Text style={styles.emptyTitle}>{t("gallery_empty")}</Text>
      <Text style={styles.emptyText}>{t("gallery_upload")}</Text>
      <Pressable
        style={styles.emptyBtn}
        onPress={() => router.push("/register-photo")}
      >
        <LinearGradient colors={[Colors.primary, Colors.primaryDark]} style={styles.emptyBtnGrad}>
          <Text style={styles.emptyBtnText}>{t("gallery_new")}</Text>
        </LinearGradient>
      </Pressable>
    </View>
  );

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[Colors.bg, "#0D1528", Colors.bg]}
        style={StyleSheet.absoluteFill}
      />
      <FlatList
        data={filteredResults}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + 100 },
        ]}
        ListHeaderComponent={<ListHeader />}
        ListEmptyComponent={!isLoading ? <EmptyState /> : null}
        renderItem={({ item }) => (
          <ResultCard
            item={item}
            isAdmin={isAdmin}
            onPress={() => router.push({ pathname: "/diagnosis/[id]", params: { id: item.id } })}
            onDelete={() => handleDelete(item)}
            commentCount={commentCounts[item.id] ?? 0}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.primary}
          />
        }
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
  adminBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: Colors.gold + "22",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.gold + "44",
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginTop: 3,
  },
  adminBadgeText: {
    color: Colors.gold,
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtn: { borderRadius: 18, overflow: "hidden" },
  addBtnGrad: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  listContent: { paddingHorizontal: 12 },
  row: { gap: 10, marginBottom: 10 },
  card: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardImageContainer: { position: "relative", height: 140 },
  cardImage: { width: "100%", height: "100%" },
  cardImagePlaceholder: {
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  cardGradient: { position: "absolute", bottom: 0, left: 0, right: 0, height: 60 },
  gradeBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  gradeBadgeText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 13,
  },
  cardProcessBadge: {
    position: "absolute",
    bottom: 6,
    right: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  cardProcessText: {
    color: Colors.textSecondary,
    fontFamily: "Inter_500Medium",
    fontSize: 9,
  },
  adminDeleteBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: Colors.danger + "CC",
    alignItems: "center",
    justifyContent: "center",
  },
  cardInfo: { padding: 10, gap: 4 },
  cardInfoRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardNameRow: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, marginRight: 6 },
  cardAvatar: { width: 22, height: 22, borderRadius: 11 },
  cardAvatarPlaceholder: { backgroundColor: Colors.surface, alignItems: "center" as const, justifyContent: "center" as const },
  cardName: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 13 },
  cardScore: { fontFamily: "Inter_700Bold", fontSize: 14 },
  cardDate: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },
  commentCountBadge: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 2,
    backgroundColor: Colors.primary + "20",
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: Colors.primary + "44",
  },
  commentCountText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
    color: Colors.primary,
  },
  courseNameBadge: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 3,
    backgroundColor: Colors.primary + "18",
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: 90,
  },
  courseNameText: {
    fontFamily: "Inter_500Medium",
    fontSize: 9,
    color: Colors.primary,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 100,
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    color: Colors.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    marginTop: 8,
  },
  emptyText: {
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },
  emptyBtn: { borderRadius: 12, overflow: "hidden", marginTop: 8 },
  emptyBtnGrad: { paddingHorizontal: 24, paddingVertical: 12 },
  emptyBtnText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 15 },
  extraPhotoBadge: {
    position: "absolute",
    bottom: 6,
    left: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  extraPhotoBadgeText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 10,
  },
  courseFilterBtn: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    marginHorizontal: 20,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primary + "44",
    alignSelf: "flex-start" as const,
  },
  courseFilterText: {
    color: Colors.primary,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
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

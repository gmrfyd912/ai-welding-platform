import React, { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  Switch,
  Modal,
  Platform,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getApiUrl } from "@/lib/query-client";
import { useAuth, type UserRole } from "@/context/AuthContext";
import Colors from "@/constants/colors";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";

const ROLES: UserRole[] = ["교육생", "교사", "관리자"];

const ROLE_COLOR: Record<string, string> = {
  관리자: "#EF4444",
  교사: "#3B82F6",
  교육생: "#10B981",
};

const PERM_LABELS: Record<string, string> = {
  can_delete_posts: "게시물 삭제",
  can_give_feedback: "AI 피드백",
};

interface AdminUser {
  id: string;
  username: string;
  password: string;
  name: string;
  role: UserRole;
  courseName?: string;
  profilePhotoUri?: string;
  permissions: string[];
}

function apiUrl(path: string) {
  return new URL(path, getApiUrl()).toString();
}

function InitialsAvatar({ name, role }: { name: string; role: string }) {
  const color = ROLE_COLOR[role] ?? Colors.primary;
  const initials = name.slice(0, 2);
  return (
    <View style={[styles.avatar, { backgroundColor: color + "22", borderColor: color + "66" }]}>
      <Text style={[styles.avatarText, { color }]}>{initials}</Text>
    </View>
  );
}

function RoleBadge({ role }: { role: string }) {
  const color = ROLE_COLOR[role] ?? Colors.primary;
  return (
    <View style={[styles.roleBadge, { backgroundColor: color + "22", borderColor: color + "55" }]}>
      <Text style={[styles.roleBadgeText, { color }]}>{role}</Text>
    </View>
  );
}

function PermBadge({ perm }: { perm: string }) {
  return (
    <View style={styles.permBadge}>
      <Text style={styles.permBadgeText}>{PERM_LABELS[perm] ?? perm}</Text>
    </View>
  );
}

export default function MembersScreen() {
  const insets = useSafeAreaInsets();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRole | "전체">("전체");
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);

  const [editRole, setEditRole] = useState<UserRole>("교육생");
  const [editPassword, setEditPassword] = useState("");
  const [editCourseName, setEditCourseName] = useState("");
  const [editPerms, setEditPerms] = useState<string[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [editProfilePhoto, setEditProfilePhoto] = useState<string | null | undefined>(undefined);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : insets.bottom;

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/admin/users"));
      if (!res.ok) throw new Error("조회 실패");
      return res.json();
    },
    enabled: currentUser?.username === "admin",
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: string; role?: UserRole; password?: string; courseName?: string; permissions?: string[] }) => {
      const { id, ...body } = payload;
      const res = await fetch(apiUrl(`/api/admin/users/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error || "수정 실패");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setEditTarget(null);
    },
    onError: (e: Error) => Alert.alert("오류", e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/admin/users/${id}`), { method: "DELETE" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error || "삭제 실패");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
    onError: (e: Error) => Alert.alert("오류", e.message),
  });

  const filtered = useMemo(() => {
    return users.filter((u) => {
      const matchRole = roleFilter === "전체" || u.role === roleFilter;
      const q = search.toLowerCase();
      const matchSearch =
        !q ||
        u.username.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q) ||
        (u.courseName ?? "").toLowerCase().includes(q);
      return matchRole && matchSearch;
    });
  }, [users, search, roleFilter]);

  const stats = useMemo(() => {
    const counts: Record<string, number> = { 관리자: 0, 교사: 0, 교육생: 0 };
    users.forEach((u) => { if (counts[u.role] !== undefined) counts[u.role]++; });
    return counts;
  }, [users]);

  const openEdit = useCallback((u: AdminUser) => {
    setEditTarget(u);
    setEditRole(u.role);
    setEditPassword("");
    setEditCourseName(u.courseName ?? "");
    setEditPerms([...(u.permissions ?? [])]);
    setShowPassword(false);
    setEditProfilePhoto(undefined);
  }, []);

  const handleSave = () => {
    if (!editTarget) return;
    const payload: any = { id: editTarget.id, role: editRole, courseName: editCourseName, permissions: editPerms };
    if (editPassword.trim()) payload.password = editPassword.trim();
    if (editProfilePhoto !== undefined) payload.profilePhotoUri = editProfilePhoto ?? null;
    updateMutation.mutate(payload);
  };

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("권한 필요", "갤러리 접근 권한이 필요합니다.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets[0]) return;
    const uri = result.assets[0].uri;
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 200, height: 200 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    setEditProfilePhoto(`data:image/jpeg;base64,${manipulated.base64}`);
  };

  const handleDelete = (u: AdminUser) => {
    Alert.alert(
      "회원 삭제",
      `'${u.name}' 계정과 모든 분석 결과·댓글이 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`,
      [
        { text: "취소", style: "cancel" },
        { text: "삭제", style: "destructive", onPress: () => deleteMutation.mutate(u.id) },
      ]
    );
  };

  const togglePerm = (perm: string) => {
    setEditPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]
    );
  };

  if (currentUser?.username !== "admin") {
    return (
      <View style={[styles.center, { paddingTop: topPad }]}>
        <Ionicons name="lock-closed" size={48} color={Colors.textMuted} />
        <Text style={styles.noAccessText}>최고관리자 전용 페이지입니다.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: bottomPad }]}>
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <Text style={styles.headerTitle}>회원 관리</Text>
        <Text style={styles.headerSub}>전체 {users.length}명</Text>
      </View>

      <View style={styles.statsRow}>
        {(["관리자", "교사", "교육생"] as UserRole[]).map((r) => (
          <Pressable
            key={r}
            style={[styles.statCard, roleFilter === r && { borderColor: ROLE_COLOR[r], backgroundColor: ROLE_COLOR[r] + "18" }]}
            onPress={() => setRoleFilter(roleFilter === r ? "전체" : r)}
          >
            <Text style={[styles.statCount, { color: ROLE_COLOR[r] }]}>{stats[r]}</Text>
            <Text style={styles.statLabel}>{r}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="이름, 아이디, 과정명 검색"
          placeholderTextColor={Colors.textMuted}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {!!search && Platform.OS !== "ios" && (
          <Pressable onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={16} color={Colors.textMuted} />
          </Pressable>
        )}
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(u) => u.id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomPad + 16 }]}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={36} color={Colors.textMuted} />
              <Text style={styles.emptyText}>검색 결과가 없습니다</Text>
            </View>
          }
          renderItem={({ item: u }) => (
            <View style={styles.card}>
              <InitialsAvatar name={u.name} role={u.role} />
              <View style={styles.cardInfo}>
                <View style={styles.cardNameRow}>
                  <Text style={styles.cardName}>{u.name}</Text>
                  <RoleBadge role={u.role} />
                </View>
                <Text style={styles.cardUsername}>@{u.username}</Text>
                {!!u.courseName && (
                  <Text style={styles.cardCourse}>{u.courseName}</Text>
                )}
                {u.permissions.length > 0 && (
                  <View style={styles.permRow}>
                    {u.permissions.map((p) => <PermBadge key={p} perm={p} />)}
                  </View>
                )}
              </View>
              <View style={styles.cardActions}>
                <Pressable
                  style={styles.editBtn}
                  onPress={() => openEdit(u)}
                  hitSlop={8}
                >
                  <Ionicons name="create-outline" size={18} color={Colors.primary} />
                </Pressable>
                {u.username !== "admin" && (
                  <Pressable
                    style={styles.deleteBtn}
                    onPress={() => handleDelete(u)}
                    hitSlop={8}
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending && deleteMutation.variables === u.id ? (
                      <ActivityIndicator size="small" color={Colors.danger} />
                    ) : (
                      <Ionicons name="trash-outline" size={18} color={Colors.danger} />
                    )}
                  </Pressable>
                )}
              </View>
            </View>
          )}
        />
      )}

      <Modal
        visible={!!editTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setEditTarget(null)}
      >
        <View style={styles.modalOverlay}>
          <KeyboardAwareScrollView
            style={styles.modalSheet}
            contentContainerStyle={styles.modalContent}
            bottomOffset={20}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>회원 정보 수정</Text>
              <Pressable onPress={() => setEditTarget(null)}>
                <Ionicons name="close" size={22} color={Colors.textMuted} />
              </Pressable>
            </View>

            {editTarget && (
              <>
                <View style={styles.modalUserInfo}>
                  <View style={styles.photoEditContainer}>
                    {(() => {
                      const photoUri = editProfilePhoto !== undefined
                        ? editProfilePhoto
                        : editTarget.profilePhotoUri;
                      const isValid = !!photoUri && (photoUri.startsWith("data:") || photoUri.startsWith("http"));
                      return isValid ? (
                        <Image source={{ uri: photoUri! }} style={styles.modalAvatar} />
                      ) : (
                        <InitialsAvatar name={editTarget.name} role={editTarget.role} />
                      );
                    })()}
                    <View style={styles.photoEditBtns}>
                      <Pressable style={styles.photoBtn} onPress={handlePickPhoto} hitSlop={6}>
                        <Ionicons name="camera-outline" size={14} color={Colors.primary} />
                        <Text style={styles.photoBtnText}>변경</Text>
                      </Pressable>
                      {(() => {
                        const photoUri = editProfilePhoto !== undefined
                          ? editProfilePhoto
                          : editTarget.profilePhotoUri;
                        const hasPhoto = !!photoUri && photoUri !== "";
                        return hasPhoto ? (
                          <Pressable
                            style={[styles.photoBtn, styles.photoBtnDelete]}
                            onPress={() => setEditProfilePhoto(null)}
                            hitSlop={6}
                          >
                            <Ionicons name="trash-outline" size={14} color={Colors.danger} />
                            <Text style={[styles.photoBtnText, { color: Colors.danger }]}>삭제</Text>
                          </Pressable>
                        ) : null;
                      })()}
                    </View>
                  </View>
                  <View>
                    <Text style={styles.modalUserName}>{editTarget.name}</Text>
                    <Text style={styles.modalUserSub}>@{editTarget.username}</Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <Text style={styles.sectionLabel}>역할</Text>
                <View style={styles.roleSelector}>
                  {ROLES.map((r) => (
                    <Pressable
                      key={r}
                      style={[
                        styles.roleOption,
                        editRole === r && { backgroundColor: ROLE_COLOR[r] + "22", borderColor: ROLE_COLOR[r] },
                      ]}
                      onPress={() => {
                        if (editTarget.username === "admin" && r !== "관리자") return;
                        setEditRole(r);
                      }}
                    >
                      <Text style={[styles.roleOptionText, editRole === r && { color: ROLE_COLOR[r], fontFamily: "Inter_600SemiBold" }]}>
                        {r}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.sectionLabel}>비밀번호 변경</Text>
                <View style={styles.passwordRow}>
                  <View style={styles.currentPasswordBox}>
                    <Text style={styles.currentPasswordLabel}>현재 비밀번호</Text>
                    <Text style={styles.currentPasswordValue}>
                      {showPassword ? editTarget.password : "•".repeat(Math.min(editTarget.password.length, 12))}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.showPasswordBtn}
                    onPress={() => setShowPassword((v) => !v)}
                    hitSlop={8}
                  >
                    <Ionicons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color={Colors.textMuted}
                    />
                  </Pressable>
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="새 비밀번호 (변경 시에만 입력)"
                  placeholderTextColor={Colors.textMuted}
                  secureTextEntry
                  value={editPassword}
                  onChangeText={setEditPassword}
                  autoCapitalize="none"
                />

                <Text style={styles.sectionLabel}>과정명</Text>
                <TextInput
                  style={styles.input}
                  placeholder="과정명"
                  placeholderTextColor={Colors.textMuted}
                  value={editCourseName}
                  onChangeText={setEditCourseName}
                />

                <Text style={styles.sectionLabel}>추가 권한</Text>
                <View style={styles.permList}>
                  {Object.entries(PERM_LABELS).map(([key, label]) => {
                    const isAdminRole = editRole === "관리자";
                    const isActive = isAdminRole || editPerms.includes(key);
                    return (
                      <View key={key} style={styles.permItem}>
                        <View>
                          <Text style={styles.permItemLabel}>{label}</Text>
                          {key === "can_delete_posts" && (
                            <Text style={styles.permItemDesc}>갤러리에서 타인의 게시물 삭제 가능</Text>
                          )}
                          {key === "can_give_feedback" && (
                            <Text style={styles.permItemDesc}>AI 분석 결과에 피드백 작성 가능</Text>
                          )}
                        </View>
                        <Switch
                          value={isActive}
                          onValueChange={isAdminRole ? undefined : () => togglePerm(key)}
                          disabled={isAdminRole}
                          trackColor={{ false: Colors.border, true: Colors.primary + "88" }}
                          thumbColor={isActive ? Colors.primary : Colors.textMuted}
                        />
                      </View>
                    );
                  })}
                </View>

                <View style={styles.divider} />

                <View style={styles.modalBtnRow}>
                  <Pressable
                    style={styles.cancelBtn}
                    onPress={() => setEditTarget(null)}
                  >
                    <Text style={styles.cancelBtnText}>취소</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.saveBtn, updateMutation.isPending && { opacity: 0.6 }]}
                    onPress={handleSave}
                    disabled={updateMutation.isPending}
                  >
                    {updateMutation.isPending ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.saveBtnText}>저장</Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </KeyboardAwareScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  noAccessText: { color: Colors.textMuted, fontFamily: "Inter_500Medium", fontSize: 15 },

  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  headerTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 24 },
  headerSub: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13 },

  statsRow: { flexDirection: "row", paddingHorizontal: 16, gap: 8, marginBottom: 12 },
  statCard: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    alignItems: "center",
    gap: 2,
  },
  statCount: { fontFamily: "Inter_700Bold", fontSize: 22 },
  statLabel: { color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 11 },

  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: { flex: 1, color: Colors.text, fontFamily: "Inter_400Regular", fontSize: 14 },

  list: { paddingHorizontal: 16, gap: 10, paddingTop: 4 },

  card: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontFamily: "Inter_700Bold", fontSize: 15 },

  cardInfo: { flex: 1, gap: 3 },
  cardNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cardName: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 15 },
  cardUsername: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 12 },
  cardCourse: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 12 },
  permRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 2 },

  roleBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  roleBadgeText: { fontFamily: "Inter_600SemiBold", fontSize: 11 },

  permBadge: {
    backgroundColor: Colors.primary + "22",
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  permBadgeText: { color: Colors.primary, fontFamily: "Inter_500Medium", fontSize: 10 },

  cardActions: { gap: 8, alignItems: "center" },
  editBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.primary + "18",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.danger + "18",
    alignItems: "center",
    justifyContent: "center",
  },

  empty: { alignItems: "center", gap: 10, paddingTop: 60 },
  emptyText: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 14 },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: Colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "90%",
  },
  modalContent: { padding: 20, paddingBottom: 40, gap: 14 },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: "center",
    marginBottom: 4,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18 },
  modalUserInfo: { flexDirection: "row", alignItems: "center", gap: 12 },
  modalAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface },
  photoEditContainer: { flexDirection: "column", alignItems: "center", gap: 6 },
  photoEditBtns: { flexDirection: "row", gap: 6 },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: Colors.primary + "18",
    borderWidth: 1,
    borderColor: Colors.primary + "44",
  },
  photoBtnDelete: {
    backgroundColor: Colors.danger + "18",
    borderColor: Colors.danger + "44",
  },
  photoBtnText: { color: Colors.primary, fontFamily: "Inter_500Medium", fontSize: 11 },
  modalUserName: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 16 },
  modalUserSub: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13 },

  divider: { height: 1, backgroundColor: Colors.border },

  sectionLabel: { color: Colors.textSecondary, fontFamily: "Inter_600SemiBold", fontSize: 12, marginBottom: -6 },

  roleSelector: { flexDirection: "row", gap: 8 },
  roleOption: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
  },
  roleOptionText: { color: Colors.textMuted, fontFamily: "Inter_500Medium", fontSize: 13 },

  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  currentPasswordBox: { flex: 1 },
  currentPasswordLabel: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11, marginBottom: 2 },
  currentPasswordValue: { color: Colors.text, fontFamily: "Inter_500Medium", fontSize: 14, letterSpacing: 1 },
  showPasswordBtn: { padding: 4 },

  input: {
    backgroundColor: Colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: Colors.text,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },

  permList: { gap: 10 },
  permItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  permItemLabel: { color: Colors.text, fontFamily: "Inter_600SemiBold", fontSize: 14 },
  permItemDesc: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11, marginTop: 2 },

  modalBtnRow: { flexDirection: "row", gap: 10 },
  cancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
  },
  cancelBtnText: { color: Colors.textSecondary, fontFamily: "Inter_600SemiBold", fontSize: 14 },
  saveBtn: {
    flex: 2,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
  },
  saveBtnText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 14 },
});

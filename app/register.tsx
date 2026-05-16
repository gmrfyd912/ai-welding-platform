import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Image,
  Alert,
  Platform,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth, UserRole } from "@/context/AuthContext";
import { LinearGradient } from "expo-linear-gradient";
import { useLanguage } from "@/context/LanguageContext";

const ROLES: UserRole[] = ["교육생", "교사", "관리자"];
const ROLE_KEYS: Record<UserRole, string> = {
  "교육생": "role_trainee",
  "교사": "role_teacher",
  "관리자": "role_admin",
};

// 날짜 포맷 헬퍼 (YYYY-MM-DD → YYYY.MM.DD 표시)
function formatDisplay(dateStr: string) {
  if (!dateStr) return "";
  return dateStr.replace(/-/g, ".");
}

// 간단한 날짜 입력 컴포넌트 (텍스트 입력 방식, YYYY-MM-DD)
function DateInput({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const [raw, setRaw] = useState(value);

  const handleChange = (text: string) => {
    // 숫자만 추출
    const nums = text.replace(/\D/g, "").slice(0, 8);
    let formatted = nums;
    if (nums.length > 4) formatted = nums.slice(0, 4) + "-" + nums.slice(4);
    if (nums.length > 6) formatted = nums.slice(0, 4) + "-" + nums.slice(4, 6) + "-" + nums.slice(6);
    setRaw(formatted);
    if (nums.length === 8) {
      onChange(formatted);
    } else {
      onChange("");
    }
  };

  return (
    <View style={dateStyles.wrapper}>
      <Text style={dateStyles.label}>
        {label} {required && <Text style={{ color: Colors.danger }}>*</Text>}
      </Text>
      <View style={dateStyles.inputRow}>
        <Ionicons name="calendar-outline" size={18} color={Colors.textMuted} style={{ marginRight: 10 }} />
        <TextInput
          style={dateStyles.input}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={Colors.textMuted}
          value={raw}
          onChangeText={handleChange}
          keyboardType="numeric"
          maxLength={10}
        />
        {value ? (
          <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />
        ) : null}
      </View>
    </View>
  );
}

const dateStyles = StyleSheet.create({
  wrapper: { gap: 6 },
  label: { color: Colors.textSecondary, fontFamily: "Inter_600SemiBold", fontSize: 13, letterSpacing: 0.5 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    height: 52,
  },
  input: { flex: 1, color: Colors.text, fontFamily: "Inter_400Regular", fontSize: 15 },
});

export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const { register } = useAuth();
  const { t } = useLanguage();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("교육생");
  const [courseName, setCourseName] = useState("");
  const [enrollDate, setEnrollDate] = useState("");
  const [graduateDate, setGraduateDate] = useState("");
  const [profilePhotoUri, setProfilePhotoUri] = useState<string | undefined>();
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const pickPhoto = async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!picked.canceled && picked.assets[0]) {
      try {
        const resized = await ImageManipulator.manipulateAsync(
          picked.assets[0].uri,
          [{ resize: { width: 200, height: 200 } }],
          { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
        );
        if (resized.base64) {
          setProfilePhotoUri(`data:image/jpeg;base64,${resized.base64}`);
        } else {
          setProfilePhotoUri(picked.assets[0].uri);
        }
      } catch {
        setProfilePhotoUri(picked.assets[0].uri);
      }
    }
  };

  const handleRegister = async () => {
    setError("");
    if (!username.trim() || !password.trim() || !name.trim()) {
      setError(t("reg_errorRequired"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("reg_errorPwMatch"));
      return;
    }
    if (password.length < 4) {
      setError(t("reg_errorPwLength"));
      return;
    }
    if (role === "교육생") {
      if (!courseName.trim()) {
        setError(t("reg_courseNameRequired"));
        return;
      }
      if (!enrollDate) {
        setError("입교일을 입력해주세요.");
        return;
      }
      if (!graduateDate) {
        setError("수료일을 입력해주세요.");
        return;
      }
      if (enrollDate >= graduateDate) {
        setError("수료일은 입교일보다 이후여야 합니다.");
        return;
      }
    }

    setIsLoading(true);
    try {
      const result = await register({
        username: username.trim(),
        password,
        name: name.trim(),
        role,
        courseName: courseName.trim() || undefined,
        profilePhotoUri: profilePhotoUri || undefined,
        enrollDate: role === "교육생" ? enrollDate : undefined,
        graduateDate: role === "교육생" ? graduateDate : undefined,
      });
      if (result.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(t("reg_title"), "회원가입 완료\n로그인해 주세요.", [
          { text: t("confirm"), onPress: () => router.replace("/login") },
        ]);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(result.error || t("reg_errorDuplicate"));
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <LinearGradient colors={["#0A0E1A", "#0D1528", "#0A0E1A"]} style={StyleSheet.absoluteFill} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("reg_title")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bottomOffset={20}
      >
        {/* 프로필 사진 */}
        <Pressable onPress={pickPhoto} style={styles.profilePhotoBtn}>
          {profilePhotoUri ? (
            <Image source={{ uri: profilePhotoUri }} style={styles.profilePhoto} />
          ) : (
            <View style={styles.profilePhotoPlaceholder}>
              <Ionicons name="camera" size={28} color={Colors.textMuted} />
              <Text style={styles.profilePhotoText}>{t("reg_profilePhoto")}{"\n"}({t("optional")})</Text>
            </View>
          )}
          {profilePhotoUri && (
            <View style={styles.profileEditBadge}>
              <Ionicons name="pencil" size={12} color="#fff" />
            </View>
          )}
        </Pressable>

        {/* 기본 정보 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("reg_name")} / {t("login_userId")} <Text style={styles.required}>*</Text></Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="person-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t("reg_name")}
              placeholderTextColor={Colors.textMuted}
              value={name}
              onChangeText={setName}
            />
          </View>
          <View style={styles.inputWrapper}>
            <Ionicons name="at-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t("login_userId")}
              placeholderTextColor={Colors.textMuted}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
            />
          </View>
          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t("login_password")}
              placeholderTextColor={Colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
            />
            <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
              <Ionicons name={showPassword ? "eye-outline" : "eye-off-outline"} size={18} color={Colors.textMuted} />
            </Pressable>
          </View>
          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t("reg_confirmPw")}
              placeholderTextColor={Colors.textMuted}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showPassword}
            />
          </View>
        </View>

        {/* 역할 선택 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("reg_role")} <Text style={styles.required}>*</Text></Text>
          <View style={styles.roleRow}>
            {ROLES.map((r) => (
              <Pressable
                key={r}
                style={[styles.roleChip, role === r && styles.roleChipActive]}
                onPress={() => { setRole(r); Haptics.selectionAsync(); }}
              >
                <Text style={[styles.roleChipText, role === r && styles.roleChipTextActive]}>
                  {t(ROLE_KEYS[r])}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* 과정명 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            {t("reg_courseName")}{" "}
            {role === "교육생"
              ? <Text style={styles.required}>*</Text>
              : <Text style={styles.optional}>({t("optional")})</Text>
            }
          </Text>
          <View style={styles.inputWrapper}>
            <MaterialCommunityIcons name="book-education-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={role === "교육생" ? "예) GTAW, FCAW, SMAW" : `${t("reg_courseName")} (${t("optional")})`}
              placeholderTextColor={Colors.textMuted}
              value={courseName}
              onChangeText={setCourseName}
            />
          </View>
        </View>

        {/* 교육생 전용: 입교일 / 수료일 */}
        {role === "교육생" && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>교육 기간 <Text style={styles.required}>*</Text></Text>
            <View style={styles.dateRow}>
              <View style={{ flex: 1 }}>
                <DateInput
                  label="입교일"
                  value={enrollDate}
                  onChange={setEnrollDate}
                  required
                />
              </View>
              <View style={styles.dateSeparator}>
                <Ionicons name="arrow-forward" size={16} color={Colors.textMuted} />
              </View>
              <View style={{ flex: 1 }}>
                <DateInput
                  label="수료일"
                  value={graduateDate}
                  onChange={setGraduateDate}
                  required
                />
              </View>
            </View>

            {/* 입력 후 진도 미리보기 */}
            {enrollDate && graduateDate && enrollDate < graduateDate && (
              <View style={styles.progressPreview}>
                <Ionicons name="bar-chart-outline" size={14} color={Colors.primary} />
                <Text style={styles.progressPreviewText}>
                  {(() => {
                    const today = new Date();
                    const enroll = new Date(enrollDate);
                    const graduate = new Date(graduateDate);
                    const total = graduate.getTime() - enroll.getTime();
                    const elapsed = today.getTime() - enroll.getTime();
                    const pct = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
                    const totalDays = Math.round(total / (1000 * 60 * 60 * 24));
                    return `총 ${totalDays}일 과정 · 현재 진도 ${pct}%`;
                  })()}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* 에러 */}
        {error ? (
          <View style={styles.errorContainer}>
            <Ionicons name="warning-outline" size={14} color={Colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* 가입 버튼 */}
        <Pressable
          style={({ pressed }) => [styles.registerBtn, pressed && { opacity: 0.85 }]}
          onPress={handleRegister}
          disabled={isLoading}
        >
          <LinearGradient
            colors={[Colors.primary, Colors.primaryDark]}
            style={styles.registerBtnGrad}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.registerBtnText}>{t("reg_title")}</Text>
            )}
          </LinearGradient>
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: { padding: 8 },
  headerTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 18 },
  content: { paddingHorizontal: 24, paddingTop: 24, gap: 20 },
  profilePhotoBtn: { alignSelf: "center", position: "relative" },
  profilePhoto: { width: 90, height: 90, borderRadius: 45, borderWidth: 3, borderColor: Colors.primary },
  profilePhotoPlaceholder: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: Colors.surface, borderWidth: 2,
    borderColor: Colors.border, borderStyle: "dashed",
    alignItems: "center", justifyContent: "center", gap: 4,
  },
  profilePhotoText: { color: Colors.textMuted, fontSize: 10, textAlign: "center", fontFamily: "Inter_400Regular" },
  profileEditBadge: {
    position: "absolute", bottom: 2, right: 2,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center",
  },
  section: { gap: 10 },
  sectionLabel: { color: Colors.textSecondary, fontFamily: "Inter_600SemiBold", fontSize: 13, letterSpacing: 0.5 },
  required: { color: Colors.danger, fontSize: 11 },
  optional: { color: Colors.textMuted, fontSize: 11 },
  inputWrapper: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 16, height: 52,
  },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, color: Colors.text, fontFamily: "Inter_400Regular", fontSize: 15 },
  eyeBtn: { padding: 4 },
  roleRow: { flexDirection: "row", gap: 10 },
  roleChip: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    backgroundColor: Colors.surface, borderWidth: 1,
    borderColor: Colors.border, alignItems: "center",
  },
  roleChipActive: { backgroundColor: Colors.primary + "22", borderColor: Colors.primary },
  roleChipText: { color: Colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 14 },
  roleChipTextActive: { color: Colors.primary },

  // 날짜 관련
  dateRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  dateSeparator: { paddingTop: 38, alignItems: "center" },
  progressPreview: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: Colors.primary + "12",
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
    borderWidth: 1, borderColor: Colors.primary + "30",
  },
  progressPreviewText: { color: Colors.primary, fontFamily: "Inter_400Regular", fontSize: 12 },

  errorContainer: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  errorText: { color: Colors.danger, fontSize: 13, fontFamily: "Inter_400Regular" },
  registerBtn: { borderRadius: 12, overflow: "hidden" },
  registerBtnGrad: { height: 54, alignItems: "center", justifyContent: "center" },
  registerBtnText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16 },
});

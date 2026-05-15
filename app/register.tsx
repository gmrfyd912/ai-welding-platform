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
    if (role === "교육생" && !courseName.trim()) {
      setError(t("reg_courseNameRequired"));
      return;
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

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("reg_role")} <Text style={styles.required}>*</Text></Text>
          <View style={styles.roleRow}>
            {ROLES.map((r) => (
              <Pressable
                key={r}
                style={[styles.roleChip, role === r && styles.roleChipActive]}
                onPress={() => { setRole(r); Haptics.selectionAsync(); }}
              >
                <Text style={[styles.roleChipText, role === r && styles.roleChipTextActive]}>{t(ROLE_KEYS[r])}</Text>
              </Pressable>
            ))}
          </View>
        </View>

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
              placeholder={role === "교육생" ? t("reg_courseName") : `${t("reg_courseName")} (${t("optional")})`}
              placeholderTextColor={Colors.textMuted}
              value={courseName}
              onChangeText={setCourseName}
            />
          </View>
        </View>

        {error ? (
          <View style={styles.errorContainer}>
            <Ionicons name="warning-outline" size={14} color={Colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

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
  headerTitle: {
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  content: { paddingHorizontal: 24, paddingTop: 24, gap: 20 },
  profilePhotoBtn: {
    alignSelf: "center",
    position: "relative",
  },
  profilePhoto: {
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 3,
    borderColor: Colors.primary,
  },
  profilePhotoPlaceholder: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: Colors.surface,
    borderWidth: 2,
    borderColor: Colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  profilePhotoText: {
    color: Colors.textMuted,
    fontSize: 10,
    textAlign: "center",
    fontFamily: "Inter_400Regular",
  },
  profileEditBadge: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  section: { gap: 10 },
  sectionLabel: {
    color: Colors.textSecondary,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    letterSpacing: 0.5,
  },
  required: { color: Colors.danger, fontSize: 11 },
  optional: { color: Colors.textMuted, fontSize: 11 },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    height: 52,
  },
  inputIcon: { marginRight: 10 },
  input: {
    flex: 1,
    color: Colors.text,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
  },
  eyeBtn: { padding: 4 },
  roleRow: { flexDirection: "row", gap: 10 },
  roleChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
  },
  roleChipActive: {
    backgroundColor: Colors.primary + "22",
    borderColor: Colors.primary,
  },
  roleChipText: {
    color: Colors.textSecondary,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  roleChipTextActive: { color: Colors.primary },
  errorContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
  },
  errorText: {
    color: Colors.danger,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  registerBtn: { borderRadius: 12, overflow: "hidden" },
  registerBtnGrad: {
    height: 54,
    alignItems: "center",
    justifyContent: "center",
  },
  registerBtnText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
});

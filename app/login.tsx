import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Image,
  Platform,
  ActivityIndicator,
  Modal,
  FlatList,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { LinearGradient } from "expo-linear-gradient";
import { useLanguage, LANGUAGES, LangCode } from "@/context/LanguageContext";
import { getApiUrl } from "@/lib/query-client";

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [showLangModal, setShowLangModal] = useState(false);

  const [visitors, setVisitors] = useState<{ total: number; today: number } | null>(null);

  useEffect(() => {
    const url = new URL("/api/visitors", getApiUrl()).toString();
    fetch(url)
      .then((r) => r.json())
      .then((d) => setVisitors(d))
      .catch(() => {});
  }, []);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : insets.bottom;

  const currentLang = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError(t("login_errorEmpty"));
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const success = await login(username.trim(), password);
      if (success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace("/(tabs)");
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(t("login_errorInvalid"));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectLang = (code: LangCode) => {
    setLang(code);
    setShowLangModal(false);
    Haptics.selectionAsync();
  };

  return (
    <View style={styles.container}>
      <LinearGradient colors={["#0D1528", "#0A0E1A", "#080C18"]} style={StyleSheet.absoluteFill} />

      <KeyboardAwareScrollView
        contentContainerStyle={[styles.content, { paddingTop: topPad + 12, paddingBottom: bottomPad + 24 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bottomOffset={20}
      >
        {/* 방문자 카운터만 (HHI 로고 제거) */}
        <View style={styles.topRow}>
          {visitors ? (
            <View style={styles.visitorBox}>
              <Ionicons name="people-outline" size={11} color={Colors.textMuted} />
              <Text style={styles.visitorText}>
                {visitors.total.toLocaleString()} / {t("login_today")} {visitors.today.toLocaleString()}
              </Text>
            </View>
          ) : <View />}
        </View>

        {/* 메인 로고 섹션 - 여백 축소 */}
        <View style={styles.logoSection}>
          <Image
            source={require("@/assets/images/weldinglogo_icon.jpg")}
            style={styles.mainLogo}
            resizeMode="cover"
          />
          <Text style={styles.appTitle}>{t("login_appTitle")}</Text>
          <Text style={styles.appSubtitle}>AI-Powered Welding Report Developed by LJM</Text>
        </View>

        {/* WELCOME BACK 구분선 */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.welcomeText}>WELCOME BACK</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.formSection}>
          <View style={styles.inputWrapper}>
            <Ionicons name="person-outline" size={18} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t("login_userId")}
              placeholderTextColor={Colors.textMuted}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              returnKeyType="next"
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
              returnKeyType="done"
              onSubmitEditing={handleLogin}
            />
            <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
              <Ionicons name={showPassword ? "eye-outline" : "eye-off-outline"} size={18} color={Colors.textMuted} />
            </Pressable>
          </View>

          {error ? (
            <View style={styles.errorContainer}>
              <Ionicons name="warning-outline" size={14} color={Colors.danger} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85 }]}
            onPress={handleLogin}
            disabled={isLoading}
          >
            <LinearGradient
              colors={[Colors.primary, Colors.primaryDark]}
              style={styles.loginBtnGrad}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.loginBtnText}>{t("login_btn")}</Text>
              )}
            </LinearGradient>
          </Pressable>

          <View style={styles.registerRow}>
            <Text style={styles.registerHint}>{t("login_noAccount")}</Text>
            <Pressable onPress={() => router.push("/register")}>
              <Text style={styles.registerLink}> {t("login_register")}</Text>
            </Pressable>
          </View>

          {/* 언어 선택 버튼 - 1/3 크기로 축소 */}
          <Pressable
            style={({ pressed }) => [styles.langBtn, pressed && { opacity: 0.75 }]}
            onPress={() => setShowLangModal(true)}
          >
            <Text style={styles.langBtnFlag}>{currentLang.flag}</Text>
            <Text style={styles.langBtnText}>{currentLang.nativeName}</Text>
            <Ionicons name="chevron-down" size={10} color={Colors.textMuted} />
          </Pressable>
        </View>
      </KeyboardAwareScrollView>

      <Modal visible={showLangModal} transparent animationType="fade" onRequestClose={() => setShowLangModal(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowLangModal(false)}>
          <View style={styles.langModal}>
            <View style={styles.langModalHeader}>
              <Text style={styles.langModalTitle}>🌐  {t("language")}</Text>
              <Pressable onPress={() => setShowLangModal(false)}>
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </Pressable>
            </View>
            <FlatList
              data={LANGUAGES}
              keyExtractor={(item) => item.code}
              renderItem={({ item }) => {
                const isSelected = item.code === lang;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.langItem,
                      isSelected && styles.langItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                    onPress={() => handleSelectLang(item.code)}
                  >
                    <Text style={styles.langItemFlag}>{item.flag}</Text>
                    <Text style={[styles.langItemText, isSelected && { color: Colors.primary }]}>
                      {item.nativeName}
                    </Text>
                    {isSelected && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
                  </Pressable>
                );
              }}
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0E1A" },
  content: { flexGrow: 1, paddingHorizontal: 28 },

  // 상단 방문자 카운터 (HHI 로고 제거, 왼쪽 정렬)
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    marginBottom: 4,
  },
  visitorBox: { flexDirection: "row", alignItems: "center", gap: 4 },
  visitorText: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 11 },

  // 로고 섹션 - 여백 대폭 축소
  logoSection: { alignItems: "center", marginTop: 20, marginBottom: 28 },
  mainLogo: { width: 140, height: 140, borderRadius: 70 },
  appTitle: {
    color: Colors.text,
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    marginTop: 14,
    textAlign: "center",
  },
  appSubtitle: {
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    marginTop: 4,
    textAlign: "center",
  },

  // WELCOME BACK 구분선
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },
  dividerLine: {
    flex: 1,
    height: 0.5,
    backgroundColor: "#2a3a5c",
  },
  welcomeText: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 3,
  },

  // 폼
  formSection: { gap: 12 },
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
  input: { flex: 1, color: Colors.text, fontFamily: "Inter_400Regular", fontSize: 15 },
  eyeBtn: { padding: 4 },
  errorContainer: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  errorText: { color: Colors.danger, fontSize: 13, fontFamily: "Inter_400Regular" },
  loginBtn: { borderRadius: 12, overflow: "hidden", marginTop: 4 },
  loginBtnGrad: { height: 52, alignItems: "center", justifyContent: "center" },
  loginBtnText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16, letterSpacing: 1 },
  registerRow: { flexDirection: "row", justifyContent: "center", alignItems: "center" },
  registerHint: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 14 },
  registerLink: { color: Colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 },

  // 언어 버튼 - 1/3 크기로 축소 (작고 컴팩트하게)
  langBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignSelf: "center",
  },
  langBtnFlag: { fontSize: 12 },
  langBtnText: { color: Colors.textMuted, fontFamily: "Inter_500Medium", fontSize: 11 },

  // 언어 모달
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  langModal: {
    backgroundColor: Colors.card,
    borderRadius: 20,
    overflow: "hidden",
    width: "100%",
    maxWidth: 360,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  langModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  langModalTitle: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 16 },
  langItem: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14, paddingHorizontal: 18 },
  langItemSelected: { backgroundColor: Colors.primary + "15" },
  langItemFlag: { fontSize: 22 },
  langItemText: { color: Colors.text, fontFamily: "Inter_500Medium", fontSize: 15, flex: 1 },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Platform, Linking } from "react-native";
import { router, Stack } from "expo-router";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Camera } from "expo-camera";
import { getApiUrl } from "@/lib/query-client";
import Colors from "@/constants/colors";

export default function CoachingLiveScreen() {
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const [permissionStatus, setPermissionStatus] = useState<string>("");

  const requestPerm = useCallback(async () => {
    try {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setPermissionStatus(status === "granted" ? "허용됨" : status);
    } catch {
      setPermissionStatus("확인 실패");
    }
  }, []);

  useEffect(() => {
    requestPerm();
  }, [requestPerm]);

  const apiBase = useMemo(() => {
    try {
      return getApiUrl();
    } catch {
      return "";
    }
  }, []);

  // Load the HTML from the backend over HTTPS so the WebView treats it as a
  // secure context (required for navigator.mediaDevices / getUserMedia).
  const pageUri = useMemo(() => {
    if (!apiBase) return "";
    return apiBase.replace(/\/$/, "") + "/coaching-live.html";
  }, [apiBase]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {pageUri ? (
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={{ uri: pageUri }}
          javaScriptEnabled
          domStorageEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          mediaCapturePermissionGrantType="grant"
          allowsProtectedMedia
          mixedContentMode="always"
          onPermissionRequest={(req: any) => {
            try { req?.nativeEvent?.grant?.(req?.nativeEvent?.resources || []); } catch {}
          }}
          style={styles.webview}
        />
      ) : (
        <View style={[styles.webview, { alignItems: "center", justifyContent: "center" }]}>
          <Text style={{ color: "#fff" }}>서버 주소를 불러올 수 없습니다.</Text>
        </View>
      )}

      {/* 떠있는 뒤로가기 — 화면을 가리지 않음 */}
      <Pressable
        onPress={() => router.back()}
        style={({ pressed }) => [
          styles.floatingBack,
          { top: insets.top + 8, left: insets.left + 8 },
          pressed && { opacity: 0.7 },
        ]}
        hitSlop={8}
      >
        <Ionicons name="chevron-back" size={20} color="#fff" />
      </Pressable>

      {permissionStatus && permissionStatus !== "허용됨" && permissionStatus !== "" && (
        <View style={[styles.permOverlay, { paddingTop: insets.top + 60 }]} pointerEvents="box-none">
          <View style={styles.permCard}>
            <Ionicons name="camera-outline" size={36} color="#fff" />
            <Text style={styles.permTitle}>카메라 권한이 필요합니다</Text>
            <Text style={styles.permBody}>
              실시간 코칭은 카메라 영상을 AI에게 보내야 합니다.{"\n"}
              아래 버튼으로 권한을 허용해주세요.
            </Text>
            <Pressable
              style={({ pressed }) => [styles.permPrimaryBtn, pressed && { opacity: 0.85 }]}
              onPress={requestPerm}
            >
              <Text style={styles.permPrimaryBtnText}>다시 권한 요청</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.permGhostBtn, pressed && { opacity: 0.7 }]}
              onPress={() => {
                if (Platform.OS === "ios" || Platform.OS === "android") {
                  Linking.openSettings();
                }
              }}
            >
              <Text style={styles.permGhostBtnText}>휴대폰 설정 열기</Text>
            </Pressable>
            <Text style={styles.permHint}>
              설정 → 앱 → Expo Go (또는 이 앱) → 권한 → 카메라 → 허용
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  webview: { flex: 1, backgroundColor: "#000" },
  floatingBack: {
    position: "absolute",
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    zIndex: 50,
  },
  permOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.85)",
    alignItems: "center",
    paddingHorizontal: 24,
    zIndex: 60,
  },
  permCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#1f1f24",
    borderRadius: 16,
    padding: 22,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  permTitle: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    marginTop: 10,
    marginBottom: 8,
    textAlign: "center",
  },
  permBody: {
    color: "rgba(255,255,255,0.78)",
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 18,
  },
  permPrimaryBtn: {
    backgroundColor: "#8B5CF6",
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 10,
    width: "100%",
    alignItems: "center",
    marginBottom: 8,
  },
  permPrimaryBtnText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  permGhostBtn: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
    width: "100%",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
  },
  permGhostBtnText: {
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  permHint: {
    color: "rgba(255,255,255,0.5)",
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    textAlign: "center",
    marginTop: 14,
    lineHeight: 16,
  },
});

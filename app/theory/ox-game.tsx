import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Pressable, Platform, ActivityIndicator, Modal, BackHandler,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as ScreenOrientation from "expo-screen-orientation";
import { GestureDetector, Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from "react-native-reanimated";
import Colors from "@/constants/colors";
import { useLanguage } from "@/context/LanguageContext";
import { useAuth } from "@/context/AuthContext";
import { apiRequest } from "@/lib/query-client";
import { OX_GAME_HTML } from "@/assets/games/oxGameHtml";

interface GameOver {
  finalWave: number;
  quizCorrect: number;
  quizTotal: number;
  isQuit: boolean;
}

export default function OXGameScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const params = useLocalSearchParams<{ mode?: string }>();
  const isResume = params.mode === "resume";
  const qc = useQueryClient();

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;

  const webRef = useRef<WebView | null>(null);
  const [ready, setReady] = useState(false);
  const [gameOver, setGameOver] = useState<GameOver | null>(null);
  const [exiting, setExiting] = useState(false);
  // Pending snapshot ack handlers keyed by ackId
  const ackResolversRef = useRef<Map<string, (snap: any) => void>>(new Map());

  // 이어하기 모드면 저장된 스냅샷을 가져온다.
  const stateQuery = useQuery<{ snapshot: any | null }>({
    queryKey: [`/api/ox/state/${user?.id}`],
    enabled: !!user?.id && isResume,
  });
  const initialSnapshot = isResume ? stateQuery.data?.snapshot ?? null : null;

  // 진행 상태/점수 저장 mutations
  const saveStateMut = useMutation({
    mutationFn: async (snapshot: any) =>
      apiRequest("POST", "/api/ox/state", { userId: user?.id, snapshot }),
  });
  const deleteStateMut = useMutation({
    mutationFn: async () =>
      apiRequest("DELETE", `/api/ox/state/${user?.id}`),
  });
  const saveScoreMut = useMutation({
    mutationFn: async (s: GameOver) =>
      apiRequest("POST", "/api/ox/scores", {
        userId: user?.id,
        userName: user?.name ?? user?.username ?? "이름없음",
        finalWave: s.finalWave,
        quizCorrect: s.quizCorrect,
        quizTotal: s.quizTotal,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/ox/leaderboard"] });
      qc.invalidateQueries({ queryKey: [`/api/ox/state/${user?.id}`] });
    },
  });

  // 진행 상태 조회 끝나기 전에는 WebView를 안 띄움(주입 누락 방지)
  const canMount = !isResume || !stateQuery.isLoading;

  // RN → WebView 명령
  const send = (type: string, extra?: Record<string, any>) => {
    webRef.current?.postMessage(JSON.stringify({ type, ...(extra ?? {}) }));
  };

  // 종료 정보 요청을 ack(약속)로 받아 RN에서 보장 — 게임을 일시정지하지 않음
  const requestExitInfoAck = (
    timeoutMs = 1500
  ): Promise<{ wasUserPaused: boolean; snapshot: any } | null> =>
    new Promise((resolve) => {
      const ackId = `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        ackResolversRef.current.delete(ackId);
        resolve(null);
      }, timeoutMs);
      ackResolversRef.current.set(ackId, (info) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ackResolversRef.current.delete(ackId);
        resolve(info);
      });
      send("getExitInfo", { ackId });
    });

  // WebView → RN 메시지
  const onMessage = (ev: WebViewMessageEvent) => {
    let msg: any;
    try { msg = JSON.parse(ev.nativeEvent.data); } catch { return; }
    if (!msg?.type) return;
    if (msg.type === "ready") {
      setReady(true);
    } else if (msg.type === "exitInfo") {
      const payload = msg.data ?? {};
      const ackId = payload.ackId;
      if (ackId && ackResolversRef.current.has(ackId)) {
        ackResolversRef.current.get(ackId)!({
          wasUserPaused: !!payload.wasUserPaused,
          snapshot: payload.snapshot,
        });
      }
    } else if (msg.type === "gameover") {
      setGameOver(msg.data);
      // 점수는 서버에 자동 등록 + 진행 상태 비움
      if (user?.id) {
        saveScoreMut.mutate(msg.data);
        deleteStateMut.mutate();
      }
    } else if (msg.type === "status") {
      // 필요 시 상단 배지에 사용 가능 (현재는 게임 내부 UI로 충분)
    }
  };

  // 안드로이드 하드웨어 백 버튼: 일시정지 + 스냅샷 저장 후 복귀
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onPressBack();
      return true;
    });
    return () => sub.remove();
  }, [ready]);

  // OX 게임 화면에서만 가로/세로 회전 허용. 화면 벗어날 땐 세로로 복원.
  useEffect(() => {
    if (Platform.OS === "web") return;
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []);

  const onPressBack = async () => {
    if (gameOver) {
      router.back();
      return;
    }
    if (!ready || !user?.id) {
      router.back();
      return;
    }
    if (exiting) return;
    setExiting(true);
    try {
      const info = await requestExitInfoAck(1500);
      if (info?.wasUserPaused && info.snapshot) {
        // 사용자가 [일시정지] 누른 상태에서만 진행 상태 저장
        try {
          await apiRequest("POST", "/api/ox/state", {
            userId: user.id,
            snapshot: info.snapshot,
          });
        } catch (e) {
          console.warn("OX state save failed", e);
        }
      } else {
        // 그 외 모든 종료(게임 진행 중 그냥 나감 / 정보 못 받음) → 저장된 진행 비움
        try {
          await apiRequest("DELETE", `/api/ox/state/${user.id}`);
        } catch (e) {
          console.warn("OX state delete failed", e);
        }
      }
    } finally {
      setExiting(false);
      router.back();
    }
  };

  const onRestart = () => {
    setGameOver(null);
    send("reset");
  };
  const onExit = () => {
    setGameOver(null);
    // 게임오버 후 [나가기] → OX 랭킹(이론학습 OX 페이지)으로
    router.replace("/theory/ox");
  };

  // 초기 상태 주입 — 페이지 로드 직후 단 한 번
  const injected = useMemo(() => {
    const seed = initialSnapshot ? JSON.stringify(initialSnapshot) : "null";
    return `
      window.__OX_INITIAL_STATE = ${seed};
      true;
    `;
  }, [initialSnapshot]);

  return (
    <View style={styles.container}>
      <View style={styles.gameWrap}>
        {!canMount && (
          <View style={styles.loader}>
            <ActivityIndicator color={Colors.primary} size="large" />
          </View>
        )}
        {canMount && (
          <WebView
            ref={webRef}
            originWhitelist={["*"]}
            source={{ html: OX_GAME_HTML }}
            injectedJavaScriptBeforeContentLoaded={injected}
            javaScriptEnabled
            domStorageEnabled
            allowFileAccess
            mixedContentMode="always"
            scalesPageToFit
            // 핀치 확대/축소 + 이동(가로/세로 양 끝까지) 지원
            scrollEnabled
            bounces
            directionalLockEnabled={false}
            setBuiltInZoomControls
            setDisplayZoomControls={false}
            minimumZoomScale={0.1}
            maximumZoomScale={5}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            onMessage={onMessage}
            style={styles.webview}
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loader}>
                <ActivityIndicator color={Colors.primary} size="large" />
              </View>
            )}
            onError={(e) => {
              console.warn("OX WebView error", e.nativeEvent);
            }}
          />
        )}
      </View>

      {/* 떠있는 뒤로가기 버튼 — 게임 화면을 가리지 않음 */}
      <Pressable
        onPress={onPressBack}
        style={({ pressed }) => [
          styles.floatingBack,
          { top: insets.top + 8, left: insets.left + 8 },
          pressed && { opacity: 0.7 },
        ]}
        hitSlop={8}
      >
        <Ionicons name="chevron-back" size={20} color="#fff" />
      </Pressable>

      {/* GAME OVER MODAL — 핀치 줌 + 더블탭 리셋 지원 */}
      <Modal visible={!!gameOver} transparent animationType="fade" onRequestClose={onExit}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <GameOverModal
            gameOver={gameOver}
            onRestart={onRestart}
            onExit={onExit}
            t={t}
          />
        </GestureHandlerRootView>
      </Modal>
    </View>
  );
}

function GameOverModal({
  gameOver,
  onRestart,
  onExit,
  t,
}: {
  gameOver: GameOver | null;
  onRestart: () => void;
  onExit: () => void;
  t: (k: string) => string;
}) {
  // 핀치 줌(0.5 ~ 3.0배) + 더블탭 1.0배 리셋
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = savedScale.value * e.scale;
      scale.value = Math.max(0.5, Math.min(3, next));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withSpring(1);
      savedScale.value = 1;
    });

  const composed = Gesture.Simultaneous(pinch, doubleTap);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={styles.modalBg}>
      <GestureDetector gesture={composed}>
        <Animated.View style={[styles.gameOverCard, animStyle]}>
          <LinearGradient
            colors={["#1E0A2E", "#0A0E1A"]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          />
          <MaterialCommunityIcons
            name={gameOver?.isQuit ? "exit-run" : "alert-octagon"}
            size={56}
            color={Colors.danger}
          />
          <Text style={styles.goTitle}>
            {gameOver?.isQuit ? t("ox_quit_title") : t("ox_gameover_title")}
          </Text>
          <Text style={styles.goSub}>{t("ox_gameover_sub")}</Text>
          <Text style={styles.zoomHint}>👆 두 손가락으로 확대 · 더블탭으로 리셋</Text>

          <View style={styles.statsBox}>
            <Stat label={t("ox_final_wave")} value={`Wave ${gameOver?.finalWave ?? 0}`} accent={Colors.primary} />
            <Stat
              label={t("ox_quiz_score")}
              value={`${gameOver?.quizCorrect ?? 0}/${gameOver?.quizTotal ?? 0}`}
              accent={Colors.gold}
            />
            <Stat
              label={t("ox_accuracy")}
              value={`${
                gameOver && gameOver.quizTotal > 0
                  ? Math.round((gameOver.quizCorrect / gameOver.quizTotal) * 100)
                  : 0
              }%`}
              accent={Colors.success}
            />
          </View>

          <View style={{ height: 12 }} />
          <Pressable
            onPress={onRestart}
            style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="refresh" size={20} color="#fff" />
            <Text style={styles.btnText}>{t("ox_retry")}</Text>
          </Pressable>
          <Pressable
            onPress={onExit}
            style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="exit-outline" size={20} color={Colors.text} />
            <Text style={[styles.btnText, { color: Colors.text }]}>{t("ox_exit")}</Text>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View style={statStyles.row}>
      <Text style={statStyles.label}>{label}</Text>
      <Text style={[statStyles.value, { color: accent }]}>{value}</Text>
    </View>
  );
}
const statStyles = StyleSheet.create({
  row: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 8, borderBottomColor: "rgba(255,255,255,0.08)", borderBottomWidth: 1,
  },
  label: { color: "#bdc3c7", fontFamily: "Inter_500Medium", fontSize: 14 },
  value: { fontFamily: "Inter_700Bold", fontSize: 18 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1319" },
  gameWrap: { flex: 1, backgroundColor: "#0b1319" },
  webview: { flex: 1, backgroundColor: "#0b1319" },
  loader: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  floatingBack: {
    position: "absolute",
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
    zIndex: 50,
  },

  modalBg: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.78)",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 22,
  },
  gameOverCard: {
    width: "100%", maxWidth: 420, padding: 26, borderRadius: 22,
    overflow: "hidden", borderColor: Colors.danger, borderWidth: 2,
    alignItems: "center",
  },
  goTitle: { color: Colors.danger, fontFamily: "Inter_700Bold", fontSize: 24, marginTop: 8 },
  goSub: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 13, marginTop: 4 },
  zoomHint: { color: "rgba(255,255,255,0.4)", fontFamily: "Inter_400Regular", fontSize: 10, marginTop: 6 },
  statsBox: {
    width: "100%", marginTop: 18, padding: 14, borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  btn: {
    width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 14, borderRadius: 12, marginTop: 8,
  },
  btnPrimary: { backgroundColor: Colors.primary },
  btnGhost: { backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: Colors.border },
  btnText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 15 },
});

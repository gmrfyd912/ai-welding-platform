import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  Alert,
} from "react-native";
import { router, Stack } from "expo-router";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Camera } from "expo-camera";
import Colors from "@/constants/colors";

const TEST_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Endoscope Camera Test</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #0b1319; color: #ecf0f1;
               font-family: -apple-system, "Malgun Gothic", sans-serif; }
  body { padding: 14px 14px 40px; }
  h2 { color: #f1c40f; margin: 8px 0 6px; font-size: 17px; }
  .row { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  button { flex: 1; min-width: 130px; padding: 12px 10px; font-size: 14px;
           font-weight: bold; border: 0; border-radius: 8px; color: white;
           background: #6C63FF; }
  button:active { opacity: 0.7; }
  button.secondary { background: #34495e; }
  button.danger { background: #c0392b; }
  select { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #34495e;
           background: #1a252c; color: #ecf0f1; font-size: 13px; margin-bottom: 10px; }
  .card { background: #1a252c; border: 1px solid #34495e; border-radius: 10px;
          padding: 12px; margin-bottom: 12px; }
  .device { padding: 8px; border-bottom: 1px solid #2c3e50; font-size: 12px; line-height: 1.5; }
  .device:last-child { border-bottom: 0; }
  .device .label { color: #2ecc71; font-weight: bold; }
  .device .id { color: #7f8c8d; font-size: 10px; word-break: break-all; }
  .device .kind { color: #3498db; font-size: 11px; }
  video { width: 100%; max-height: 280px; background: black; border-radius: 8px;
          display: block; }
  #log { background: #000; color: #2ecc71; padding: 10px; border-radius: 6px;
         font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.5;
         max-height: 220px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
  .log-err { color: #e74c3c; }
  .log-warn { color: #f39c12; }
  .empty { color: #7f8c8d; font-style: italic; padding: 8px; text-align: center; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px;
          background: #2c3e50; color: #ecf0f1; font-size: 11px; margin-left: 6px; }
  .ok { background: #27ae60; }
  .bad { background: #c0392b; }
</style>
</head>
<body>

<h2>① 비디오 입력 장치 목록</h2>
<div class="row">
  <button onclick="enumerate()">🔄 목록 새로고침</button>
  <button class="secondary" onclick="requestPermissionThenEnumerate()">🔐 권한 요청 + 새로고침</button>
</div>
<div class="card">
  <div id="device-list"><div class="empty">아직 조회 안 됨</div></div>
</div>

<h2>② 카메라 선택 & 시작</h2>
<select id="device-select"><option value="">-- 디바이스 선택 (자동 선택은 빈 상태) --</option></select>
<div class="row">
  <button onclick="startCamera()">🎥 카메라 시작</button>
  <button class="danger" onclick="stopCamera()">⏹ 정지</button>
</div>
<div class="card">
  <video id="weldingPreview" autoplay playsinline muted></video>
  <div id="stream-info" style="margin-top:8px; font-size:12px; color:#bdc3c7;">스트림 없음</div>
</div>

<h2>③ 실행 로그</h2>
<div id="log">대기중...\\n</div>

<script>
  let currentStream = null;

  function logLine(msg, cls) {
    const el = document.getElementById('log');
    const ts = new Date().toLocaleTimeString();
    const span = document.createElement('div');
    if (cls) span.className = cls;
    span.textContent = '[' + ts + '] ' + msg;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'log', level: cls || 'info', msg })
      );
    } catch (e) {}
  }

  function renderDevices(devices) {
    const wrap = document.getElementById('device-list');
    const sel = document.getElementById('device-select');
    sel.innerHTML = '<option value="">-- 자동 선택 --</option>';

    if (!devices.length) {
      wrap.innerHTML = '<div class="empty">videoinput 장치가 0개 입니다.</div>';
      return;
    }
    wrap.innerHTML = '';
    devices.forEach((d, i) => {
      const div = document.createElement('div');
      div.className = 'device';
      const label = d.label || '(label 비공개 — 권한 필요)';
      const isExternal = /usb|uvc|endo|external/i.test(label);
      div.innerHTML =
        '<div class="label">' + (i+1) + '. ' + label +
        (isExternal ? '<span class="pill ok">외부 가능성</span>' : '<span class="pill">내장 추정</span>') +
        '</div>' +
        '<div class="kind">kind: ' + d.kind + '</div>' +
        '<div class="id">id: ' + (d.deviceId || '(empty)') + '</div>';
      wrap.appendChild(div);

      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = (i+1) + '. ' + label.substring(0, 40);
      sel.appendChild(opt);
    });
  }

  async function enumerate() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        logLine('navigator.mediaDevices.enumerateDevices 미지원!', 'log-err');
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      logLine('총 ' + devices.length + '개 장치 / videoinput ' + videoDevices.length + '개');
      videoDevices.forEach((d, i) => {
        logLine('  [' + (i+1) + '] ' + (d.label || '(label 비공개)') + ' / id=' + (d.deviceId.slice(0,12) || 'empty'));
      });
      renderDevices(videoDevices);
    } catch (e) {
      logLine('enumerate 에러: ' + e.message, 'log-err');
    }
  }

  async function requestPermissionThenEnumerate() {
    try {
      logLine('권한 요청용 임시 stream 시작...');
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      logLine('권한 OK — 임시 stream 종료');
      tmp.getTracks().forEach(t => t.stop());
      await enumerate();
    } catch (e) {
      logLine('권한 요청 실패: ' + e.name + ' / ' + e.message, 'log-err');
      await enumerate();
    }
  }

  async function startCamera() {
    try {
      stopCamera();
      const sel = document.getElementById('device-select');
      const id = sel.value;
      const constraints = {
        video: id
          ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } }
      };
      logLine('getUserMedia 요청: ' + JSON.stringify(constraints.video));
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentStream = stream;
      const video = document.getElementById('weldingPreview');
      video.srcObject = stream;
      await video.play();

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      logLine('스트림 시작! track=' + track.label);
      logLine('설정: ' + settings.width + 'x' + settings.height + ' @' + (settings.frameRate || '?') + 'fps');
      document.getElementById('stream-info').textContent =
        '✅ ' + track.label + ' (' + settings.width + 'x' + settings.height + ')';
      // 권한이 부여됐으니 라벨이 보이도록 다시 enumerate
      await enumerate();
    } catch (e) {
      logLine('startCamera 실패: ' + e.name + ' / ' + e.message, 'log-err');
    }
  }

  function stopCamera() {
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
      currentStream = null;
      document.getElementById('weldingPreview').srcObject = null;
      document.getElementById('stream-info').textContent = '스트림 없음';
      logLine('스트림 정지');
    }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      logLine('🔌 devicechange 이벤트 — 장치 변경 감지!', 'log-warn');
      enumerate();
    });
  }

  // 자동 초기 조회
  setTimeout(enumerate, 300);
</script>
</body>
</html>`;

export default function CoachingTestScreen() {
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const [permissionStatus, setPermissionStatus] = useState<string>("확인 중…");

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Camera.requestCameraPermissionsAsync();
        setPermissionStatus(status === "granted" ? "허용됨 ✓" : `${status} (제한될 수 있음)`);
      } catch (e) {
        setPermissionStatus("확인 실패");
      }
    })();
  }, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* 헤더 */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>내시경 카메라 테스트</Text>
          <Text style={styles.subtitle}>네이티브 권한: {permissionStatus}</Text>
        </View>
        <Pressable
          onPress={() => webRef.current?.reload()}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
        >
          <Ionicons name="refresh" size={20} color={Colors.text} />
        </Pressable>
      </View>

      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={{ html: TEST_HTML }}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        // iOS: 카메라/마이크 권한을 자동 승인
        mediaCapturePermissionGrantType="grant"
        // Android: WebRTC의 origin 신뢰 처리
        mixedContentMode="always"
        onMessage={(e) => {
          try {
            const data = JSON.parse(e.nativeEvent.data);
            if (data.type === "log" && data.level === "log-err") {
              console.warn("[coaching-test]", data.msg);
            }
          } catch {}
        }}
        style={styles.webview}
        onShouldStartLoadWithRequest={(req) => {
          // 외부 링크는 차단 (안전)
          if (req.url.startsWith("about:") || req.url.startsWith("data:") || req.url === "about:blank") {
            return true;
          }
          return true;
        }}
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
        <Text style={styles.footerText}>
          💡 안드로이드에 USB 내시경을 연결한 뒤 ① 목록을 새로고침하세요. 외부 카메라가 잡히지 않으면 ② 권한 요청 후 다시 시도해주세요.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1319" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 10,
    backgroundColor: Colors.bg,
    borderBottomColor: Colors.border,
    borderBottomWidth: 1,
    gap: 10,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.card,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.card,
  },
  title: { color: Colors.text, fontFamily: "Inter_700Bold", fontSize: 16 },
  subtitle: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 2 },
  webview: { flex: 1, backgroundColor: "#0b1319" },
  footer: {
    paddingHorizontal: 14,
    paddingTop: 10,
    backgroundColor: Colors.card,
    borderTopColor: Colors.border,
    borderTopWidth: 1,
  },
  footerText: { color: Colors.textSecondary, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 18 },
});

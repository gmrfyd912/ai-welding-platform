import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  Alert,
  ActivityIndicator,
  Modal,
  FlatList,
  Platform,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { getApiUrl } from "@/lib/query-client";

function apiUrl(path: string) {
  return new URL(path, getApiUrl()).toString();
}

// ── 상수 ──
const WELD_TYPES = ["SMAW", "GTAW", "GMAW", "FCAW", "SAW", "EGW", "기타"];
const MATERIALS = ["연강 평판", "연강 배관", "스테인리스 평판", "스테인리스 배관", "알루미늄", "기타"];
const POSTURES = ["1F", "2F", "3F", "4F", "5F", "1G", "2G", "3G", "4G", "5G", "6G", "기타"];
const RESULTS = ["합격", "불합격"];
const ISSUERS = ["한국산업인력공단", "대한용접접합학회", "선급", "기타"];

interface ExamRecord {
  id: string;
  userId: string;
  userName: string;
  courseName?: string;
  examDate: string;
  weldType: string;
  material: string;
  posture: string;
  result: string;
  issuer?: string;
  certNumber?: string;
  memo?: string;
  createdAt: string;
}

// ── 선택 칩 컴포넌트 ──
function ChipGroup({
  options,
  value,
  onChange,
  color = Colors.primary,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  color?: string;
}) {
  return (
    <View style={chipStyles.row}>
      {options.map((opt) => (
        <Pressable
          key={opt}
          style={[chipStyles.chip, value === opt && { backgroundColor: color + "22", borderColor: color }]}
          onPress={() => { onChange(opt); Haptics.selectionAsync(); }}
        >
          <Text style={[chipStyles.text, value === opt && { color }]}>{opt}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const chipStyles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 20, borderWidth: 1, borderColor: "#2a3a5c",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  text: { color: "#7a8aaa", fontFamily: "Inter_500Medium", fontSize: 13 },
});

// ── 기록 카드 ──
function RecordCard({
  item,
  canDelete,
  onDelete,
}: {
  item: ExamRecord;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const isPass = item.result === "합격";
  const color = isPass ? "#10b981" : "#ef4444";

  return (
    <View style={cardStyles.card}>
      <View style={cardStyles.top}>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={cardStyles.titleRow}>
            <Text style={cardStyles.weldType}>{item.weldType}</Text>
            <View style={[cardStyles.resultBadge, { backgroundColor: color + "22", borderColor: color }]}>
              <Text style={[cardStyles.resultText, { color }]}>{item.result}</Text>
            </View>
          </View>
          <Text style={cardStyles.sub}>
            {item.material} · {item.posture} · {item.examDate.replace(/-/g, ".")}
          </Text>
          {item.userName && (
            <Text style={cardStyles.userName}>{item.userName}{item.courseName ? ` · ${item.courseName}` : ""}</Text>
          )}
        </View>
        {canDelete && (
          <Pressable onPress={onDelete} style={cardStyles.deleteBtn} hitSlop={8}>
            <Ionicons name="trash-outline" size={16} color={Colors.danger} />
          </Pressable>
        )}
      </View>
      {(item.issuer || item.certNumber || item.memo) && (
        <View style={cardStyles.bottom}>
          {item.issuer && <Text style={cardStyles.detail}>발급: {item.issuer}</Text>}
          {item.certNumber && <Text style={cardStyles.detail}>자격번호: {item.certNumber}</Text>}
          {item.memo && <Text style={cardStyles.detail}>메모: {item.memo}</Text>}
        </View>
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 0.5, borderColor: "#2a3a5c",
    borderRadius: 14, padding: 14, gap: 10,
  },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  weldType: { color: "#e2e8f0", fontFamily: "Inter_700Bold", fontSize: 15 },
  resultBadge: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  resultText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  sub: { color: "#7a8aaa", fontFamily: "Inter_400Regular", fontSize: 12 },
  userName: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 11 },
  deleteBtn: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: Colors.danger + "18",
    alignItems: "center", justifyContent: "center",
  },
  bottom: {
    borderTopWidth: 0.5, borderTopColor: "#2a3a5c",
    paddingTop: 8, gap: 3,
  },
  detail: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 12 },
});

// ── 메인 화면 ──
export default function ExamRecordScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const isStaff = user?.role === "교사" || user?.role === "관리자";
  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const [records, setRecords] = useState<ExamRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 폼 상태
  const [examDate, setExamDate] = useState("");
  const [weldType, setWeldType] = useState("");
  const [material, setMaterial] = useState("");
  const [posture, setPosture] = useState("");
  const [result, setResult] = useState("");
  const [issuer, setIssuer] = useState("");
  const [certNumber, setCertNumber] = useState("");
  const [memo, setMemo] = useState("");

  // 교사/관리자용 학생 필터
  const [selectedUserId, setSelectedUserId] = useState<string>("전체");
  const [studentList, setStudentList] = useState<Array<{ id: string; name: string; courseName?: string }>>([]);

  const loadRecords = useCallback(async () => {
    setIsLoading(true);
    try {
      const url = isStaff
        ? apiUrl("/api/exam-records")
        : apiUrl(`/api/exam-records?userId=${user?.id}`);
      const res = await fetch(url);
      if (res.ok) setRecords(await res.json());
    } catch {}
    finally { setIsLoading(false); }
  }, [isStaff, user?.id]);

  const loadStudents = useCallback(async () => {
    if (!isStaff) return;
    try {
      const res = await fetch(apiUrl("/api/auth/students"));
      if (res.ok) {
        const data = await res.json();
        setStudentList(data.map((u: any) => ({ id: u.id, name: u.name, courseName: u.courseName })));
      }
    } catch {}
  }, [isStaff]);

  useEffect(() => {
    loadRecords();
    loadStudents();
  }, [loadRecords, loadStudents]);

  const resetForm = () => {
    setExamDate(""); setWeldType(""); setMaterial("");
    setPosture(""); setResult(""); setIssuer("");
    setCertNumber(""); setMemo("");
  };

  const handleSubmit = async () => {
    if (!examDate || !weldType || !material || !posture || !result) {
      Alert.alert("입력 오류", "시험일자, 용접종류, 재질, 자세, 합불 여부는 필수입니다.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/exam-records"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user?.id,
          userName: user?.name,
          courseName: user?.courseName,
          examDate, weldType, material, posture, result,
          issuer: issuer || undefined,
          certNumber: certNumber || undefined,
          memo: memo || undefined,
        }),
      });
      if (res.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setShowForm(false);
        resetForm();
        loadRecords();
      } else {
        Alert.alert("오류", "저장에 실패했습니다.");
      }
    } catch {
      Alert.alert("오류", "네트워크 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (id: string, userName: string) => {
    Alert.alert(
      "기록 삭제",
      `${userName}의 시험 기록을 삭제하시겠습니까?`,
      [
        { text: "취소", style: "cancel" },
        {
          text: "삭제", style: "destructive",
          onPress: async () => {
            try {
              await fetch(apiUrl(`/api/exam-records/${id}`), { method: "DELETE" });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              loadRecords();
            } catch {}
          },
        },
      ]
    );
  };

  // 날짜 입력 핸들러
  const handleDateChange = (text: string) => {
    const nums = text.replace(/\D/g, "").slice(0, 8);
    let formatted = nums;
    if (nums.length > 4) formatted = nums.slice(0, 4) + "-" + nums.slice(4);
    if (nums.length > 6) formatted = nums.slice(0, 4) + "-" + nums.slice(4, 6) + "-" + nums.slice(6);
    setExamDate(formatted);
  };

  // 필터링된 기록
  const filteredRecords = isStaff && selectedUserId !== "전체"
    ? records.filter((r) => r.userId === selectedUserId)
    : records;

  const passCount = filteredRecords.filter((r) => r.result === "합격").length;
  const failCount = filteredRecords.filter((r) => r.result === "불합격").length;

  return (
    <View style={[styles.container, { paddingTop: topPad + 8 }]}>
      <LinearGradient colors={["#0D1528", "#0A0E1A", "#080C18"]} style={StyleSheet.absoluteFill} />

      {/* 헤더 */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#e2e8f0" />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>평가 · 자격 기록</Text>
          <Text style={styles.headerSub}>
            전체 {filteredRecords.length}건 · 합격 {passCount} · 불합격 {failCount}
          </Text>
        </View>
        {!isStaff && (
          <Pressable
            style={styles.addBtn}
            onPress={() => { setShowForm(true); Haptics.selectionAsync(); }}
          >
            <LinearGradient colors={[Colors.primary, Colors.primaryDark]} style={styles.addBtnGrad}>
              <Ionicons name="add" size={22} color="#fff" />
            </LinearGradient>
          </Pressable>
        )}
      </View>

      {/* 교사/관리자: 학생 필터 */}
      {isStaff && studentList.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterScroll}
          contentContainerStyle={styles.filterContent}
        >
          <Pressable
            style={[styles.filterChip, selectedUserId === "전체" && styles.filterChipActive]}
            onPress={() => setSelectedUserId("전체")}
          >
            <Text style={[styles.filterChipText, selectedUserId === "전체" && styles.filterChipTextActive]}>전체</Text>
          </Pressable>
          {studentList.map((s) => (
            <Pressable
              key={s.id}
              style={[styles.filterChip, selectedUserId === s.id && styles.filterChipActive]}
              onPress={() => setSelectedUserId(s.id)}
            >
              <Text style={[styles.filterChipText, selectedUserId === s.id && styles.filterChipTextActive]}>
                {s.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* 기록 목록 */}
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : filteredRecords.length === 0 ? (
        <View style={styles.center}>
          <MaterialCommunityIcons name="certificate-outline" size={48} color="#2a3a5c" />
          <Text style={styles.emptyText}>등록된 시험 기록이 없어요</Text>
          {!isStaff && (
            <Pressable
              style={styles.emptyBtn}
              onPress={() => setShowForm(true)}
            >
              <Text style={styles.emptyBtnText}>첫 기록 추가하기</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          data={filteredRecords}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <RecordCard
              item={item}
              canDelete={isStaff || item.userId === user?.id}
              onDelete={() => handleDelete(item.id, item.userName)}
            />
          )}
        />
      )}

      {/* 기록 입력 모달 */}
      <Modal
        visible={showForm}
        animationType="slide"
        transparent
        onRequestClose={() => { setShowForm(false); resetForm(); }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>시험 기록 추가</Text>
              <Pressable onPress={() => { setShowForm(false); resetForm(); }}>
                <Ionicons name="close" size={22} color="#7a8aaa" />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.formContent}>

              {/* 시험일자 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>시험일자 <Text style={{ color: Colors.danger }}>*</Text></Text>
                <View style={styles.inputRow}>
                  <Ionicons name="calendar-outline" size={18} color="#4a5e80" style={{ marginRight: 8 }} />
                  <TextInput
                    style={styles.input}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#4a5e80"
                    value={examDate}
                    onChangeText={handleDateChange}
                    keyboardType="numeric"
                    maxLength={10}
                  />
                </View>
              </View>

              {/* 용접 종류 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>용접 종류 <Text style={{ color: Colors.danger }}>*</Text></Text>
                <ChipGroup options={WELD_TYPES} value={weldType} onChange={setWeldType} color={Colors.primary} />
              </View>

              {/* 재질 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>재질 <Text style={{ color: Colors.danger }}>*</Text></Text>
                <ChipGroup options={MATERIALS} value={material} onChange={setMaterial} color="#8b5cf6" />
              </View>

              {/* 자세 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>자세 <Text style={{ color: Colors.danger }}>*</Text></Text>
                <ChipGroup options={POSTURES} value={posture} onChange={setPosture} color="#f97316" />
              </View>

              {/* 합불 여부 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>합격 여부 <Text style={{ color: Colors.danger }}>*</Text></Text>
                <View style={styles.resultRow}>
                  {RESULTS.map((r) => {
                    const isPass = r === "합격";
                    const color = isPass ? "#10b981" : "#ef4444";
                    const isSelected = result === r;
                    return (
                      <Pressable
                        key={r}
                        style={[styles.resultChip, isSelected && { backgroundColor: color + "22", borderColor: color }]}
                        onPress={() => { setResult(r); Haptics.selectionAsync(); }}
                      >
                        <Ionicons
                          name={isPass ? "checkmark-circle-outline" : "close-circle-outline"}
                          size={18}
                          color={isSelected ? color : "#4a5e80"}
                        />
                        <Text style={[styles.resultChipText, isSelected && { color }]}>{r}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* 발급 기관 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>발급 기관</Text>
                <ChipGroup options={ISSUERS} value={issuer} onChange={setIssuer} color="#60a5fa" />
              </View>

              {/* 자격증 번호 (합격 시) */}
              {result === "합격" && (
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>자격증 번호</Text>
                  <View style={styles.inputRow}>
                    <Ionicons name="ribbon-outline" size={18} color="#4a5e80" style={{ marginRight: 8 }} />
                    <TextInput
                      style={styles.input}
                      placeholder="자격증 번호 입력"
                      placeholderTextColor="#4a5e80"
                      value={certNumber}
                      onChangeText={setCertNumber}
                    />
                  </View>
                </View>
              )}

              {/* 메모 */}
              <View style={styles.formGroup}>
                <Text style={styles.formLabel}>메모</Text>
                <TextInput
                  style={[styles.inputRow, styles.memoInput]}
                  placeholder="자유롭게 메모하세요"
                  placeholderTextColor="#4a5e80"
                  value={memo}
                  onChangeText={setMemo}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
              </View>

              {/* 저장 버튼 */}
              <Pressable
                style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                onPress={handleSubmit}
                disabled={submitting}
              >
                <LinearGradient
                  colors={[Colors.primary, Colors.primaryDark]}
                  style={styles.submitBtnGrad}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                >
                  {submitting
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={styles.submitBtnText}>저장하기</Text>
                  }
                </LinearGradient>
              </Pressable>

            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0E1A" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingBottom: 12, gap: 10,
  },
  backBtn: { padding: 4 },
  headerTitle: { color: "#e2e8f0", fontFamily: "Inter_700Bold", fontSize: 20 },
  headerSub: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 2 },
  addBtn: { borderRadius: 18, overflow: "hidden" },
  addBtnGrad: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },

  filterScroll: { maxHeight: 44, marginBottom: 8 },
  filterContent: { paddingHorizontal: 16, gap: 8, alignItems: "center" },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, borderWidth: 0.5, borderColor: "#2a3a5c",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  filterChipActive: { backgroundColor: Colors.primary + "22", borderColor: Colors.primary },
  filterChipText: { color: "#7a8aaa", fontFamily: "Inter_500Medium", fontSize: 12 },
  filterChipTextActive: { color: Colors.primary },

  list: { paddingHorizontal: 16, paddingBottom: 40, gap: 10, paddingTop: 8 },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyText: { color: "#4a5e80", fontFamily: "Inter_400Regular", fontSize: 14 },
  emptyBtn: {
    marginTop: 8, paddingHorizontal: 20, paddingVertical: 10,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.primary,
  },
  emptyBtnText: { color: Colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: "#0D1528",
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 1, borderColor: "#2a3a5c",
    maxHeight: "92%",
  },
  modalHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: "#2a3a5c", alignSelf: "center", marginTop: 12, marginBottom: 4,
  },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: "#2a3a5c",
  },
  modalTitle: { color: "#e2e8f0", fontFamily: "Inter_700Bold", fontSize: 18 },

  formContent: { padding: 20, gap: 20, paddingBottom: 40 },
  formGroup: { gap: 10 },
  formLabel: { color: "#7a8aaa", fontFamily: "Inter_600SemiBold", fontSize: 13 },

  inputRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 0.5, borderColor: "#2a3a5c",
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
  },
  input: { flex: 1, color: "#e2e8f0", fontFamily: "Inter_400Regular", fontSize: 14 },
  memoInput: {
    minHeight: 80, alignItems: "flex-start",
    color: "#e2e8f0", fontFamily: "Inter_400Regular", fontSize: 14,
  },

  resultRow: { flexDirection: "row", gap: 12 },
  resultChip: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingVertical: 12, borderRadius: 12,
    borderWidth: 1, borderColor: "#2a3a5c",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  resultChipText: { color: "#7a8aaa", fontFamily: "Inter_600SemiBold", fontSize: 14 },

  submitBtn: { borderRadius: 12, overflow: "hidden", marginTop: 8 },
  submitBtnGrad: { height: 52, alignItems: "center", justifyContent: "center" },
  submitBtnText: { color: "#fff", fontFamily: "Inter_700Bold", fontSize: 16 },
});

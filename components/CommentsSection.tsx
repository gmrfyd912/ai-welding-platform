import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import Colors from "@/constants/colors";

export interface Comment {
  id: number;
  resultId: string;
  parentId: number | null;
  userId: string;
  userName: string;
  userRole: string;
  content: string;
  createdAt: number;
  replies: Comment[];
}

const ROLE_COLORS: Record<string, string> = {
  관리자: Colors.danger,
  admin: Colors.danger,
  교사: Colors.primary,
  교육생: Colors.success,
};

const ROLE_LABELS: Record<string, string> = {
  관리자: "관리자",
  admin: "관리자",
  교사: "교사",
  교육생: "교육생",
};

function timeAgo(ts: number, t: (key: string) => string): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return t("cm_justNow");
  if (diff < 3600) return t("cm_minAgo").replace("{n}", String(Math.floor(diff / 60)));
  if (diff < 86400) return t("cm_hourAgo").replace("{n}", String(Math.floor(diff / 3600)));
  return t("cm_dayAgo").replace("{n}", String(Math.floor(diff / 86400)));
}

function RoleBadge({ role }: { role: string }) {
  const color = ROLE_COLORS[role] ?? Colors.textMuted;
  const label = ROLE_LABELS[role] ?? role;
  return (
    <View style={[styles.roleBadge, { backgroundColor: color + "22", borderColor: color + "55" }]}>
      <Text style={[styles.roleBadgeText, { color }]}>{label}</Text>
    </View>
  );
}

function CommentItem({
  comment,
  isAdmin,
  currentUserId,
  onReply,
  onDelete,
  t,
}: {
  comment: Comment;
  isAdmin: boolean;
  currentUserId: string;
  onReply: (comment: Comment) => void;
  onDelete: (id: number) => void;
  t: (key: string) => string;
}) {
  const canDelete = isAdmin || comment.userId === currentUserId;

  return (
    <View style={styles.commentItem}>
      <View style={styles.commentHeader}>
        <View style={styles.commentMeta}>
          <Text style={styles.commentUserName}>{comment.userName}</Text>
          <RoleBadge role={comment.userRole} />
        </View>
        <Text style={styles.commentTime}>{timeAgo(comment.createdAt, t)}</Text>
      </View>
      <Text style={styles.commentContent}>{comment.content}</Text>
      <View style={styles.commentActions}>
        <Pressable style={styles.commentActionBtn} onPress={() => onReply(comment)}>
          <Ionicons name="return-down-forward-outline" size={13} color={Colors.primary} />
          <Text style={styles.commentActionText}>{t("cm_reply")}</Text>
        </Pressable>
        {canDelete && (
          <Pressable style={styles.commentActionBtn} onPress={() => onDelete(comment.id)}>
            <Ionicons name="trash-outline" size={13} color={Colors.textMuted} />
          </Pressable>
        )}
      </View>

      {comment.replies.length > 0 && (
        <View style={styles.repliesContainer}>
          {comment.replies.map((reply) => (
            <View key={reply.id} style={styles.replyItem}>
              <View style={styles.replyLine} />
              <View style={styles.replyContent}>
                <View style={styles.commentHeader}>
                  <View style={styles.commentMeta}>
                    <Text style={styles.commentUserName}>{reply.userName}</Text>
                    <RoleBadge role={reply.userRole} />
                  </View>
                  <Text style={styles.commentTime}>{timeAgo(reply.createdAt, t)}</Text>
                </View>
                <Text style={styles.commentContent}>{reply.content}</Text>
                {(isAdmin || reply.userId === currentUserId) && (
                  <Pressable style={styles.commentActionBtn} onPress={() => onDelete(reply.id)}>
                    <Ionicons name="trash-outline" size={13} color={Colors.textMuted} />
                  </Pressable>
                )}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export default function CommentsSection({ resultId }: { resultId: string }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [inputText, setInputText] = useState("");
  const [replyTarget, setReplyTarget] = useState<Comment | null>(null);
  const inputRef = useRef<TextInput>(null);
  const isAdmin = user?.username === "admin";

  const { data: comments = [], isLoading } = useQuery<Comment[]>({
    queryKey: ["/api/comments", resultId],
    queryFn: async () => {
      const url = new URL(`/api/comments/${resultId}`, getApiUrl());
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 30000,
  });

  const totalCount = comments.reduce((acc, c) => acc + 1 + c.replies.length, 0);

  const addMutation = useMutation({
    mutationFn: async (data: { content: string; parentId?: number }) => {
      const res = await apiRequest("POST", "/api/comments", {
        resultId,
        parentId: data.parentId ?? null,
        userId: user?.id,
        userName: user?.name ?? user?.username,
        userRole: user?.role ?? "교육생",
        content: data.content,
      });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/comments", resultId] });
      qc.invalidateQueries({ queryKey: ["/api/comments-count"] });
      setInputText("");
      setReplyTarget(null);
    },
    onError: () => Alert.alert(t("error"), t("cm_addFailed")),
  });

  const deleteMutation = useMutation({
    mutationFn: async (commentId: number) => {
      const url = new URL(`/api/comments/${commentId}`, getApiUrl());
      url.searchParams.set("userId", user?.id ?? "");
      url.searchParams.set("isAdmin", isAdmin ? "true" : "false");
      const res = await fetch(url.toString(), { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/comments", resultId] });
      qc.invalidateQueries({ queryKey: ["/api/comments-count"] });
    },
    onError: () => Alert.alert(t("error"), t("cm_deleteFailed")),
  });

  const handleDelete = (commentId: number) => {
    Alert.alert(t("cm_deleteTitle"), t("cm_deleteConfirm"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("adm_delete"), style: "destructive", onPress: () => deleteMutation.mutate(commentId) },
    ]);
  };

  const handleReply = (comment: Comment) => {
    setReplyTarget(comment);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const handleSubmit = () => {
    if (!inputText.trim()) return;
    addMutation.mutate({
      content: inputText.trim(),
      parentId: replyTarget?.id,
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <MaterialCommunityIcons name="comment-multiple-outline" size={17} color={Colors.primary} />
        <Text style={styles.headerTitle}>{t("cm_comments")}</Text>
        {totalCount > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{totalCount}</Text>
          </View>
        )}
      </View>

      {isLoading ? (
        <ActivityIndicator color={Colors.primary} style={{ margin: 16 }} />
      ) : comments.length === 0 ? (
        <Text style={styles.emptyText}>{t("cm_empty")}</Text>
      ) : (
        <View style={styles.commentsList}>
          {comments.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              isAdmin={isAdmin}
              currentUserId={user?.id ?? ""}
              onReply={handleReply}
              onDelete={handleDelete}
              t={t}
            />
          ))}
        </View>
      )}

      {replyTarget && (
        <View style={styles.replyBanner}>
          <Ionicons name="return-down-forward-outline" size={13} color={Colors.primary} />
          <Text style={styles.replyBannerText} numberOfLines={1}>
            {t("cm_replyTo").replace("{name}", replyTarget.userName)}
          </Text>
          <Pressable onPress={() => setReplyTarget(null)} style={{ marginLeft: "auto" }}>
            <Ionicons name="close" size={15} color={Colors.textMuted} />
          </Pressable>
        </View>
      )}

      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder={replyTarget ? t("cm_replyInputPlaceholder").replace("{name}", replyTarget.userName) : t("cm_inputPlaceholder")}
          placeholderTextColor={Colors.textMuted}
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={500}
          returnKeyType="default"
        />
        <Pressable
          style={[styles.sendBtn, (!inputText.trim() || addMutation.isPending) && { opacity: 0.4 }]}
          onPress={handleSubmit}
          disabled={!inputText.trim() || addMutation.isPending}
        >
          {addMutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="send" size={16} color="#fff" />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 14,
  },
  headerTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    color: Colors.text,
  },
  countBadge: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 20,
    alignItems: "center",
  },
  countBadgeText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    color: "#fff",
  },
  emptyText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    paddingVertical: 12,
  },
  commentsList: {
    gap: 0,
  },
  commentItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border + "66",
  },
  commentHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  commentMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  commentUserName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.text,
  },
  roleBadge: {
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: 1,
  },
  roleBadgeText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
  },
  commentTime: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.textMuted,
  },
  commentContent: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
    marginBottom: 6,
  },
  commentActions: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  commentActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
  },
  commentActionText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: Colors.primary,
  },
  repliesContainer: {
    marginTop: 8,
    gap: 0,
  },
  replyItem: {
    flexDirection: "row",
    marginLeft: 8,
  },
  replyLine: {
    width: 2,
    backgroundColor: Colors.border,
    marginRight: 10,
    borderRadius: 1,
  },
  replyContent: {
    flex: 1,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border + "44",
  },
  replyBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.primary + "15",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.primary + "33",
  },
  replyBannerText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.textSecondary,
    flex: 1,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.text,
    maxHeight: 100,
    minHeight: 40,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});

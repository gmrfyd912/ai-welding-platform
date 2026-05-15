import { Plus, LogOut, BookOpen, MessageCircle, Award, TrendingUp, Shield } from "lucide-react";

const C = {
  bg: "#0A0E1A",
  card: "#131929",
  surface: "#1C2640",
  border: "#243050",
  primary: "#00B4FF",
  primaryDark: "#0082BB",
  gold: "#FFB800",
  text: "#FFFFFF",
  textSecondary: "#8B9DB8",
  textMuted: "#4A5A78",
  gradeA_plus: "#00D68F",
  gradeA: "#4CAF50",
  gradeA_minus: "#8BC34A",
  gradeB: "#2196F3",
  gradeC: "#FF9800",
  gradeD: "#FF5722",
  gradeF: "#F44336",
};

function gradeColor(score: number) {
  if (score >= 95) return C.gradeA_plus;
  if (score >= 90) return C.gradeA;
  if (score >= 85) return C.gradeA_minus;
  if (score >= 80) return C.gradeB;
  if (score >= 70) return C.gradeC;
  if (score >= 60) return C.gradeD;
  return C.gradeF;
}

function grade(score: number) {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

const WELDING_IMAGES = [
  "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=400&h=300&fit=crop&q=80",
  "https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=400&h=300&fit=crop&q=80",
  "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=300&fit=crop&q=80",
  "https://images.unsplash.com/photo-1587293852726-70cdb56c2866?w=400&h=300&fit=crop&q=80",
];

const results = [
  { id: "1", userName: "김지훈", score: 97, process: "SMAW", date: "3/14 09:22", course: "기초반 A", comments: 3, img: WELDING_IMAGES[0] },
  { id: "2", userName: "박서연", score: 88, process: "MIG", date: "3/14 10:05", course: "심화반 B", comments: 1, img: WELDING_IMAGES[1] },
  { id: "3", userName: "이민준", score: 74, process: "TIG", date: "3/13 14:30", course: "기초반 A", comments: 0, img: WELDING_IMAGES[2] },
  { id: "4", userName: "최하은", score: 91, process: "FCAW", date: "3/13 11:15", course: "심화반 B", comments: 2, img: WELDING_IMAGES[3] },
  { id: "5", userName: "정도현", score: 62, process: "SMAW", date: "3/12 16:45", course: "기초반 A", comments: 0, img: WELDING_IMAGES[0] },
  { id: "6", userName: "윤수아", score: 95, process: "MIG", date: "3/12 09:30", course: "심화반 B", comments: 4, img: WELDING_IMAGES[1] },
];

const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);

function ElevatedCard({ item }: { item: typeof results[0] }) {
  const gc = gradeColor(item.score);
  const g = grade(item.score);

  return (
    <div style={{
      flex: 1,
      borderRadius: 18,
      overflow: "hidden",
      background: C.card,
      border: `1px solid ${gc}28`,
      boxShadow: `0 0 0 0px ${gc}00, 0 2px 12px rgba(0,0,0,0.4)`,
      display: "flex",
      flexDirection: "column",
      transition: "all 0.2s",
    }}>
      <div style={{ position: "relative", height: 170 }}>
        <img
          src={item.img}
          alt="weld"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        <div style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(135deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.75) 100%)`,
        }} />
        <div style={{
          position: "absolute", top: 8, left: 8,
          width: 36, height: 36,
          borderRadius: 12,
          background: `${gc}EE`,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 0 16px ${gc}66`,
        }}>
          <span style={{
            color: "#fff", fontWeight: 800, fontSize: g.length > 1 ? 11 : 14,
            fontFamily: "Inter, sans-serif", letterSpacing: "-0.5px",
          }}>{g}</span>
        </div>

        <div style={{
          position: "absolute", top: 8, right: 8,
          background: "rgba(0,0,0,0.50)",
          backdropFilter: "blur(8px)",
          borderRadius: 8, padding: "3px 7px",
          border: "1px solid rgba(255,255,255,0.1)",
        }}>
          <span style={{ color: "#ccc", fontSize: 9, fontWeight: 500, fontFamily: "Inter, sans-serif" }}>{item.process}</span>
        </div>

        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          padding: "20px 10px 9px",
          background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)",
          display: "flex", alignItems: "flex-end", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{
              width: 20, height: 20, borderRadius: 10,
              background: C.surface,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: "1px solid rgba(255,255,255,0.1)",
            }}>
              <span style={{ fontSize: 9 }}>👤</span>
            </div>
            <span style={{ color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "Inter, sans-serif" }}>{item.userName}</span>
          </div>
          <div style={{
            background: `${gc}22`,
            border: `1px solid ${gc}66`,
            borderRadius: 8, padding: "2px 7px",
            backdropFilter: "blur(4px)",
          }}>
            <span style={{ color: gc, fontSize: 14, fontWeight: 700, fontFamily: "Inter, sans-serif" }}>{item.score}점</span>
          </div>
        </div>
      </div>

      <div style={{ padding: "8px 10px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: C.textMuted, fontSize: 10, fontFamily: "Inter, sans-serif" }}>{item.date}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          {item.comments > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 2,
              background: `${C.primary}18`,
              border: `1px solid ${C.primary}33`,
              borderRadius: 8, padding: "2px 6px",
            }}>
              <MessageCircle size={8} color={C.primary} />
              <span style={{ color: C.primary, fontSize: 9, fontWeight: 600, fontFamily: "Inter, sans-serif" }}>{item.comments}</span>
            </div>
          )}
          {item.course && (
            <div style={{
              display: "flex", alignItems: "center", gap: 3,
              background: `${C.primary}15`,
              borderRadius: 7, padding: "2px 6px",
            }}>
              <BookOpen size={8} color={C.primary} />
              <span style={{ color: C.primary, fontSize: 9, fontWeight: 500, fontFamily: "Inter, sans-serif", maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.course}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Elevated() {
  const rows: [typeof results[0], typeof results[0]][] = [];
  for (let i = 0; i < results.length; i += 2) {
    rows.push([results[i], results[i + 1]]);
  }

  return (
    <div style={{ width: 390, minHeight: 844, background: C.bg, fontFamily: "Inter, sans-serif", overflowX: "hidden" }}>
      <div style={{
        background: "linear-gradient(180deg, rgba(13,21,40,0.97) 0%, rgba(10,14,26,0.95) 100%)",
        padding: "52px 16px 14px",
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
              <span style={{ color: C.text, fontSize: 23, fontWeight: 700, letterSpacing: "-0.5px" }}>실습 갤러리</span>
              <div style={{
                display: "flex", alignItems: "center", gap: 3,
                background: `${C.gold}15`, border: `1px solid ${C.gold}44`,
                borderRadius: 8, padding: "3px 7px",
              }}>
                <Shield size={10} color={C.gold} />
                <span style={{ color: C.gold, fontSize: 10, fontWeight: 700 }}>관리자</span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Award size={11} color={C.textMuted} />
                <span style={{ color: C.textSecondary, fontSize: 11 }}><span style={{ color: C.text, fontWeight: 600 }}>6</span>개 결과물</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <TrendingUp size={11} color={C.primary} />
                <span style={{ color: C.textSecondary, fontSize: 11 }}>평균 <span style={{ color: C.primary, fontWeight: 700 }}>{avgScore}점</span></span>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button style={{
              width: 38, height: 38, borderRadius: 12,
              border: `1px solid ${C.border}`,
              background: C.surface,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer",
            }}>
              <LogOut size={16} color={C.textSecondary} />
            </button>
            <button style={{
              width: 38, height: 38, borderRadius: 12,
              border: "none", cursor: "pointer",
              background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDark})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 4px 14px ${C.primary}50`,
            }}>
              <Plus size={20} color="#fff" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
          {["전체", "기초반 A", "심화반 B"].map((label, i) => (
            <button key={label} style={{
              display: "flex", alignItems: "center", gap: 5,
              background: i === 0 ? `${C.primary}20` : "transparent",
              border: i === 0 ? `1px solid ${C.primary}55` : `1px solid ${C.border}`,
              borderRadius: 10, padding: "6px 12px",
              cursor: "pointer", whiteSpace: "nowrap",
            }}>
              <span style={{ color: i === 0 ? C.primary : C.textSecondary, fontSize: 12, fontWeight: i === 0 ? 600 : 400 }}>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "13px 12px 40px", display: "flex", flexDirection: "column", gap: 11 }}>
        {rows.map(([a, b], i) => (
          <div key={i} style={{ display: "flex", gap: 11 }}>
            <ElevatedCard item={a} />
            {b ? <ElevatedCard item={b} /> : <div style={{ flex: 1 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

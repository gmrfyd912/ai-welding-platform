import { Flame, Plus, LogOut, ChevronDown, MessageCircle, BookOpen, Images, Shield } from "lucide-react";

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

function Card({ item }: { item: typeof results[0] }) {
  const gc = gradeColor(item.score);
  const g = grade(item.score);

  return (
    <div style={{
      background: C.card,
      borderRadius: 16,
      overflow: "hidden",
      border: `1px solid ${C.border}`,
      flex: 1,
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{ position: "relative", height: 162 }}>
        <img
          src={item.img}
          alt="weld"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(to bottom, rgba(0,0,0,0) 40%, rgba(0,0,0,0.72) 100%)",
        }} />
        <div style={{
          position: "absolute", top: 8, left: 8,
          width: 34, height: 34, borderRadius: 10,
          background: gc,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 2px 8px ${gc}55`,
        }}>
          <span style={{ color: "#fff", fontWeight: 800, fontSize: 13, fontFamily: "Inter, sans-serif" }}>{g}</span>
        </div>
        <div style={{
          position: "absolute", bottom: 7, left: 7,
          background: "rgba(0,0,0,0.55)",
          borderRadius: 6, padding: "2px 6px",
          backdropFilter: "blur(4px)",
        }}>
          <span style={{ color: C.textSecondary, fontSize: 9, fontFamily: "Inter, sans-serif", fontWeight: 500 }}>{item.process}</span>
        </div>
        <div style={{
          position: "absolute", bottom: 7, right: 7,
          background: `${gc}22`,
          border: `1px solid ${gc}55`,
          borderRadius: 8, padding: "3px 7px",
        }}>
          <span style={{ color: gc, fontWeight: 700, fontSize: 13, fontFamily: "Inter, sans-serif" }}>{item.score}</span>
        </div>
      </div>

      <div style={{ padding: "9px 10px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 22, height: 22, borderRadius: 11,
            background: C.surface,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <span style={{ color: C.textMuted, fontSize: 10 }}>👤</span>
          </div>
          <span style={{ color: C.text, fontSize: 13, fontWeight: 600, fontFamily: "Inter, sans-serif", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.userName}</span>
          {item.comments > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 2,
              background: `${C.primary}20`,
              border: `1px solid ${C.primary}44`,
              borderRadius: 8, padding: "2px 5px",
            }}>
              <MessageCircle size={8} color={C.primary} />
              <span style={{ color: C.primary, fontSize: 9, fontWeight: 600, fontFamily: "Inter, sans-serif" }}>{item.comments}</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: C.textMuted, fontSize: 10, fontFamily: "Inter, sans-serif" }}>{item.date}</span>
          {item.course && (
            <div style={{
              display: "flex", alignItems: "center", gap: 3,
              background: `${C.primary}18`,
              borderRadius: 6, padding: "2px 5px",
            }}>
              <BookOpen size={8} color={C.primary} />
              <span style={{ color: C.primary, fontSize: 9, fontFamily: "Inter, sans-serif", fontWeight: 500, maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.course}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Refined() {
  const rows: [typeof results[0], typeof results[0]][] = [];
  for (let i = 0; i < results.length; i += 2) {
    rows.push([results[i], results[i + 1]]);
  }

  return (
    <div style={{ width: 390, minHeight: 844, background: C.bg, fontFamily: "Inter, sans-serif", overflowX: "hidden" }}>
      <div style={{
        background: "linear-gradient(180deg, #0D1528 0%, #0A0E1A 100%)",
        padding: "52px 16px 12px",
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: C.text, fontSize: 22, fontWeight: 700 }}>실습 갤러리</span>
              <div style={{
                display: "flex", alignItems: "center", gap: 4,
                background: `${C.gold}15`,
                border: `1px solid ${C.gold}44`,
                borderRadius: 8, padding: "3px 8px",
              }}>
                <Shield size={11} color={C.gold} />
                <span style={{ color: C.gold, fontSize: 10, fontWeight: 600 }}>관리자</span>
              </div>
            </div>
            <span style={{ color: C.textSecondary, fontSize: 12, display: "block", marginTop: 2 }}>6개의 결과물</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button style={{
              width: 36, height: 36, borderRadius: 10, border: `1px solid ${C.border}`,
              background: C.surface, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}>
              <LogOut size={16} color={C.textSecondary} />
            </button>
            <button style={{
              width: 36, height: 36, borderRadius: 10, border: "none", cursor: "pointer",
              background: `linear-gradient(135deg, ${C.primary}, ${C.primaryDark})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 2px 10px ${C.primary}44`,
            }}>
              <Plus size={20} color="#fff" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <button style={{
          display: "flex", alignItems: "center", gap: 6,
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 10, padding: "8px 12px",
          cursor: "pointer", width: "fit-content",
        }}>
          <BookOpen size={13} color={C.primary} />
          <span style={{ color: C.primary, fontSize: 13, fontWeight: 500 }}>전체</span>
          <ChevronDown size={13} color={C.primary} />
        </button>
      </div>

      <div style={{ padding: "12px 12px 40px", display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map(([a, b], i) => (
          <div key={i} style={{ display: "flex", gap: 10 }}>
            <Card item={a} />
            {b ? <Card item={b} /> : <div style={{ flex: 1 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

export const Colors = {
  bg: "#0A0E1A",
  card: "#131929",
  surface: "#1C2640",
  border: "#243050",
  primary: "#00B4FF",
  primaryDark: "#0082BB",
  gold: "#FFB800",
  silver: "#C0C8D8",
  bronze: "#CD7F32",
  text: "#FFFFFF",
  textSecondary: "#8B9DB8",
  textMuted: "#4A5A78",
  success: "#00D68F",
  danger: "#FF3B55",
  warning: "#FFB800",
  gradeA_plus: "#00D68F",
  gradeA: "#4CAF50",
  gradeA_minus: "#8BC34A",
  gradeB: "#2196F3",
  gradeC: "#FF9800",
  gradeD: "#FF5722",
  gradeF: "#F44336",
  tabActive: "#00B4FF",
  tabInactive: "#4A5A78",
};

export function getGradeColor(score: number): string {
  if (score >= 95) return Colors.gradeA_plus;
  if (score >= 90) return Colors.gradeA;
  if (score >= 85) return Colors.gradeA_minus;
  if (score >= 80) return Colors.gradeB;
  if (score >= 70) return Colors.gradeC;
  if (score >= 60) return Colors.gradeD;
  return Colors.gradeF;
}

export function getGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export default Colors;

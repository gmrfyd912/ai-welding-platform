const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function importData() {
  const data = JSON.parse(fs.readFileSync('C:/Users/82105/Desktop/prod_backup.json'));
  const tables = data.tables;

  // weld_users
  console.log('weld_users importing...');
  for (const u of tables.weld_users) {
    try {
      await pool.query(
        `INSERT INTO weld_users (id, username, password, role, profile_photo_uri, course_name, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [u.id, u.username, u.password, u.role, u.profile_photo_uri, u.course_name, u.created_at]
      );
    } catch(e) { console.error('user error:', u.username, e.message); }
  }
  console.log('weld_users 완료!');

  // weld_results
  console.log('weld_results importing...');
  for (const r of tables.weld_results) {
    try {
      await pool.query(
        `INSERT INTO weld_results (id, user_id, user_name, user_profile_uri, user_course_name,
         photo_uri, photos, process, process_custom, posture, posture_custom, material, material_custom,
         bead_type, self_score, ai_score, grade, overall_verdict, bead_analysis, defects,
         defect_locations, photo_analyses, improvements, comprehensive_report, top3_defects,
         trend_scores, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.user_id, r.user_name, r.user_profile_uri, r.user_course_name,
         r.photo_uri, JSON.stringify(r.photos), r.process, r.process_custom,
         r.posture, r.posture_custom, r.material, r.material_custom, r.bead_type,
         r.self_score, r.ai_score, r.grade, r.overall_verdict,
         JSON.stringify(r.bead_analysis), JSON.stringify(r.defects),
         JSON.stringify(r.defect_locations), JSON.stringify(r.photo_analyses),
         JSON.stringify(r.improvements), r.comprehensive_report,
         JSON.stringify(r.top3_defects), JSON.stringify(r.trend_scores), r.timestamp]
      );
    } catch(e) { console.error('result error:', r.id, e.message); }
  }
  console.log('weld_results 완료!');

  // weld_theory_attempts
  console.log('weld_theory_attempts importing...');
  for (const t of tables.weld_theory_attempts) {
    try {
      await pool.query(
        `INSERT INTO weld_theory_attempts (user_id, day_key, question_id, difficulty, selected_index, correct_index, is_correct, attempted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, day_key, question_id) DO NOTHING`,
        [t.user_id, t.day_key, t.question_id, t.difficulty, t.selected_index, t.correct_index, t.is_correct, t.attempted_at]
      );
    } catch(e) { console.error('theory error:', e.message); }
  }
  console.log('weld_theory_attempts 완료!');

  console.log('✅ 모든 데이터 이전 완료!');
  await pool.end();
}

importData().catch(console.error);
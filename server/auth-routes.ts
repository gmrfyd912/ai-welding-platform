import type { Express, Request, Response } from "express";
import pool from "./db";

const BUILD_TOKEN = Date.now().toString();

async function ensurePermissionsColumn() {
  await pool.query(`ALTER TABLE weld_users ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT '[]'`);
}
ensurePermissionsColumn().catch(console.error);

async function ensureVisitorTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_visitors (
      visit_date DATE PRIMARY KEY,
      count INT DEFAULT 0
    )
  `);
}
ensureVisitorTable().catch(console.error);

function rowToAdminUser(u: any) {
  let perms: string[] = [];
  try { perms = JSON.parse(u.permissions || "[]"); } catch {}
  return {
    id: u.id,
    username: u.username,
    password: u.password,
    name: u.name,
    role: u.role,
    courseName: u.course_name ?? undefined,
    profilePhotoUri: u.profile_photo_uri ?? undefined,
    permissions: perms,
  };
}

export function registerAuthRoutes(app: Express): void {
  app.get("/api/app-version", (_req: Request, res: Response) => {
    res.json({ buildToken: BUILD_TOKEN });
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "아이디와 패스워드를 입력해주세요." });
    try {
      const result = await pool.query(
        "SELECT * FROM weld_users WHERE username = $1 AND password = $2",
        [username, password]
      );
      if (result.rows.length === 0) return res.status(401).json({ error: "아이디 또는 패스워드가 올바르지 않습니다." });
      const user = result.rows[0];
      let perms: string[] = [];
      try { perms = JSON.parse(user.permissions || "[]"); } catch {}
      res.json({
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        courseName: user.course_name ?? undefined,
        profilePhotoUri: user.profile_photo_uri ?? undefined,
        permissions: perms,
      });
    } catch (err) {
      console.error("login error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const { username, password, name, role, courseName, profilePhotoUri } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: "필수 항목을 입력해주세요." });
    try {
      const dupName = await pool.query("SELECT id FROM weld_users WHERE name = $1", [name]);
      if (dupName.rows.length > 0) return res.status(409).json({ error: "이미 사용 중인 이름입니다. 다른 이름을 사용해주세요." });
      const id = Date.now().toString() + Math.random().toString(36).substr(2, 6);
      await pool.query(
        "INSERT INTO weld_users (id, username, password, name, role, course_name, profile_photo_uri) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [id, username, password, name, role || "trainee", courseName || null, profilePhotoUri || null]
      );
      res.json({ id, username, name, role: role || "trainee", courseName: courseName || undefined, profilePhotoUri: profilePhotoUri || undefined });
    } catch (err: any) {
      if (err.code === "23505") return res.status(409).json({ error: "이미 사용 중인 아이디입니다." });
      console.error("register error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.put("/api/auth/profile", async (req: Request, res: Response) => {
    const { id, name, profilePhotoUri, password } = req.body;
    if (!id) return res.status(400).json({ error: "사용자 ID가 필요합니다." });
    try {
      const fields: string[] = [];
      const values: any[] = [];
      let idx = 1;
      if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
      if (profilePhotoUri !== undefined) { fields.push(`profile_photo_uri = $${idx++}`); values.push(profilePhotoUri); }
      if (password !== undefined) { fields.push(`password = $${idx++}`); values.push(password); }
      if (fields.length === 0) return res.status(400).json({ error: "변경할 내용이 없습니다." });
      values.push(id);
      const result = await pool.query(
        `UPDATE weld_users SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      const user = result.rows[0];
      res.json({
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        profilePhotoUri: user.profile_photo_uri ?? undefined,
      });
    } catch (err) {
      console.error("profile update error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/auth/user/:id", async (req: Request, res: Response) => {
    try {
      const result = await pool.query("SELECT * FROM weld_users WHERE id = $1", [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      const user = result.rows[0];
      let perms: string[] = [];
      try { perms = JSON.parse(user.permissions || "[]"); } catch {}
      res.json({
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        courseName: user.course_name ?? undefined,
        profilePhotoUri: user.profile_photo_uri ?? undefined,
        permissions: perms,
      });
    } catch (err) {
      console.error("get user error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/admin/users", async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT id, username, password, name, role, course_name, profile_photo_uri, permissions
         FROM weld_users
         ORDER BY CASE role WHEN '관리자' THEN 0 WHEN '교사' THEN 1 ELSE 2 END, name ASC`
      );
      res.json(result.rows.map(rowToAdminUser));
    } catch (err) {
      console.error("admin get users error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.put("/api/admin/users/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { role, password, courseName, permissions, profilePhotoUri } = req.body;
    try {
      const fields: string[] = [];
      const values: any[] = [];
      let idx = 1;
      if (role !== undefined) { fields.push(`role = $${idx++}`); values.push(role); }
      if (password !== undefined && password !== "") { fields.push(`password = $${idx++}`); values.push(password); }
      if (courseName !== undefined) { fields.push(`course_name = $${idx++}`); values.push(courseName || null); }
      if (permissions !== undefined) { fields.push(`permissions = $${idx++}`); values.push(JSON.stringify(permissions)); }
      if (profilePhotoUri !== undefined) { fields.push(`profile_photo_uri = $${idx++}`); values.push(profilePhotoUri || null); }
      if (fields.length === 0) return res.status(400).json({ error: "변경할 내용이 없습니다." });
      values.push(id);
      const result = await pool.query(
        `UPDATE weld_users SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      res.json(rowToAdminUser(result.rows[0]));
    } catch (err) {
      console.error("admin update user error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

  app.get("/api/visitors", async (_req: Request, res: Response) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO site_visitors (visit_date, count) VALUES ($1, 1)
         ON CONFLICT (visit_date) DO UPDATE SET count = site_visitors.count + 1`,
        [today]
      );
      const totalRes = await pool.query(`SELECT COALESCE(SUM(count), 0) as total FROM site_visitors`);
      const todayRes = await pool.query(`SELECT COALESCE(count, 0) as today FROM site_visitors WHERE visit_date = $1`, [today]);
      res.json({
        total: parseInt(totalRes.rows[0].total),
        today: parseInt(todayRes.rows[0]?.today ?? "0"),
      });
    } catch (err) {
      console.error("visitor error:", err);
      res.json({ total: 0, today: 0 });
    }
  });

  app.delete("/api/admin/users/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const check = await pool.query("SELECT username FROM weld_users WHERE id = $1", [id]);
      if (check.rows.length === 0) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      if (check.rows[0].username === "admin") return res.status(403).json({ error: "관리자 계정은 삭제할 수 없습니다." });
      await pool.query("DELETE FROM weld_comments WHERE user_id = $1", [id]);
      await pool.query("DELETE FROM weld_results WHERE user_id = $1", [id]);
      await pool.query("DELETE FROM weld_users WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (err) {
      console.error("admin delete user error:", err);
      res.status(500).json({ error: "서버 오류" });
    }
  });

}

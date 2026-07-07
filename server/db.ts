import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

export default pool;

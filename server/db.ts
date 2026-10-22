import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "admin" | "responder" | "viewer";
export type User = { id: string; name: string; email: string; role: Role };
export const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
};
export function verifyPassword(password: string, hash: string) {
  const [salt, digest] = hash.split(":");
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  // A schema version makes later upgrades explicit instead of silently changing a live database.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','responder','viewer'))
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, owner TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incidents(
      id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL,
      description TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
      status TEXT NOT NULL CHECK(status IN ('open','investigating','monitoring','resolved')),
      service_id TEXT NOT NULL REFERENCES services(id), assignee_id TEXT REFERENCES users(id),
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      resolved_at TEXT, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS events(
      id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id),
      actor_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_incident ON events(incident_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));
  `);
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
export function transaction<T>(db: DB, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function seedDemo(db: DB) {
  if ((db.prepare("SELECT count(*) AS count FROM users").get() as {count:number}).count) return;
  transaction(db, () => {
    const people = [
      ["admin", "Alex Morgan", "admin@signaldesk.demo", "admin"],
      ["responder", "Jamie Chen", "responder@signaldesk.demo", "responder"],
      ["viewer", "Sam Rivera", "viewer@signaldesk.demo", "viewer"],
    ];
    for (const [id,name,email,role] of people) db.prepare("INSERT INTO users VALUES(?,?,?,?,?)").run(id,name,email,hashPassword("DemoPass123!"),role);
    const services = [
      ["api","Core API","Public REST API and request routing","Platform"],
      ["payments","Payments","Checkout, billing and payment processing","Commerce"],
      ["auth","Authentication","Identity, sessions and access control","Platform"],
      ["web","Web application","Customer dashboard and frontend delivery","Experience"],
    ];
    for (const service of services) db.prepare("INSERT INTO services VALUES(?,?,?,?)").run(...service);
    const samples = [
      ["Elevated latency on checkout endpoint","Payment requests are exceeding the expected response time. Investigating connection pool saturation.","high","investigating","payments","responder",3],
      ["Intermittent API gateway errors","A subset of requests return 502 responses in the primary region.","critical","open","api",null,1],
      ["Delayed session token refresh","A mitigation has been deployed. Watching refresh success rates before closing.","medium","monitoring","auth","admin",6],
      ["Dashboard assets failing to load","A CDN cache purge restored delivery of static assets.","low","resolved","web","responder",26],
      ["Webhook delivery retries increasing","Downstream timeout corrected and backlog processed.","medium","resolved","payments","admin",48],
      ["API request queue saturation","Worker capacity restored after correcting autoscaling configuration.","high","resolved","api","responder",72],
    ] as const;
    samples.forEach(([title,description,severity,status,service,assignee,hours],index) => {
      const id = randomUUID();
      const created = new Date(Date.now()-hours*3600000).toISOString();
      const updated = status === "resolved" ? new Date(Date.parse(created)+45*60000).toISOString() : created;
      db.prepare("INSERT INTO incidents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,index+1,title,description,severity,status,service,assignee,"admin",created,updated,status==="resolved"?updated:null,1);
      db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(randomUUID(),id,"admin","created","Incident reported",created);
      if (status !== "open") db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(randomUUID(),id,assignee || "admin","status","Status changed to "+status,updated);
    });
  });
}



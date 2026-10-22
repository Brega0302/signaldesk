import express, { type Request, type Response, type NextFunction } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, verifyPassword, hashPassword, type DB, type User } from "./db.ts";

type AuthRequest = Request & { user?: User };
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function sessionToken(req: Request) {
  const value = req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("sd_session="))?.slice(11);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
const incidentInput = z.object({
  title: z.string().trim().min(8).max(140),
  description: z.string().trim().min(15).max(5000),
  severity: z.enum(["critical","high","medium","low"]),
  serviceId: z.string().min(1),
}).strict();
const transitionMap: Record<string,string[]> = {
  open: ["investigating"], investigating: ["monitoring"], monitoring: ["investigating","resolved"], resolved: ["open"],
};
const baseSelect = `SELECT i.*, s.name AS service_name, u.name AS assignee_name FROM incidents i
 JOIN services s ON s.id=i.service_id LEFT JOIN users u ON u.id=i.assignee_id`;
export function createApp(db: DB, options: { secureCookie?: boolean } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req,res,next) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id",requestId);
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Referrer-Policy","same-origin");
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control","no-store");
    // Browser writes must originate on this host. JSON-only bodies block simple cross-site form posts.
    if (!["GET","HEAD","OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({error:"Cross-site request blocked",requestId});
      if (origin) {
        try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({error:"Origin not allowed",requestId}); }
        catch { return res.status(403).json({error:"Invalid origin",requestId}); }
      }
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") return res.status(415).json({error:"Use application/json",requestId});
    }
    next();
  });
  app.use(express.json({limit:"32kb"}));
  const attempts = new Map<string,{count:number;reset:number}>();
  // Equal-cost password verification prevents the obvious unknown-email timing shortcut.
  const dummyHash = hashPassword(randomBytes(24).toString("hex"));
  app.get("/api/health",(_req,res) => res.json({status:"ok"}));
  app.post("/api/auth/login",(req,res) => {
    const parsed = z.object({email:z.string().email().max(254),password:z.string().min(1).max(128)}).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400,"Enter a valid email and password");
    const key = req.ip || "unknown";
    const now = Date.now();
    // Evict expired buckets and bound memory used by untrusted clients.
    for (const [key,value] of attempts) if (value.reset < now) attempts.delete(key);
    let bucket = attempts.get(key);
    if (!bucket) { if (attempts.size >= 10000) throw new HttpError(429,"Login temporarily busy"); bucket={count:0,reset:now+15*60000}; attempts.set(key,bucket); }
    if (bucket.count >= 10) { res.setHeader("Retry-After",String(Math.ceil((bucket.reset-now)/1000))); throw new HttpError(429,"Too many attempts. Try again in 15 minutes."); }
    bucket.count++;
    const user = db.prepare("SELECT * FROM users WHERE email=?").get(parsed.data.email.toLowerCase()) as (User & {password_hash:string}) | undefined;
    const valid = verifyPassword(parsed.data.password,user?.password_hash || dummyHash);
    if (!user || !valid) throw new HttpError(401,"Email or password is incorrect");
    attempts.delete(key);
    const token = randomBytes(32).toString("hex");
    transaction(db,()=>{
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
      const old = sessionToken(req);
      if (old) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(old));
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest(token),user.id,now+8*3600000);
    });
    res.cookie("sd_session",token,{httpOnly:true,sameSite:"strict",secure:!!options.secureCookie,maxAge:8*3600000,path:"/"});
    res.json({user:{id:user.id,name:user.name,email:user.email,role:user.role}});
  });
  app.use("/api",(req: AuthRequest,_res,next) => {
    const token = sessionToken(req);
    if (!token) throw new HttpError(401,"Please sign in");
    const user = db.prepare("SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?").get(digest(token),Date.now()) as User | undefined;
    if (!user) throw new HttpError(401,"Session expired. Please sign in again.");
    req.user=user; next();
  });
  const canWrite = (req: AuthRequest,_res: Response,next: NextFunction) => {
    if (req.user?.role === "viewer") throw new HttpError(403,"Viewer accounts have read-only access");
    next();
  };
  app.get("/api/auth/me",(req: AuthRequest,res)=>res.json({user:req.user}));
  app.post("/api/auth/logout",(req,res)=>{
    const token=sessionToken(req);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(token));
    res.clearCookie("sd_session",{httpOnly:true,sameSite:"strict",secure:!!options.secureCookie,path:"/"});
    res.status(204).end();
  });
  app.get("/api/users",(_req,res)=>res.json(db.prepare("SELECT id,name,role FROM users ORDER BY name").all()));
  app.get("/api/services",(_req,res)=>res.json(db.prepare(`
    SELECT s.*, CASE
      WHEN EXISTS(SELECT 1 FROM incidents i WHERE i.service_id=s.id AND i.status!='resolved' AND i.severity='critical') THEN 'outage'
      WHEN EXISTS(SELECT 1 FROM incidents i WHERE i.service_id=s.id AND i.status!='resolved') THEN 'degraded'
      ELSE 'operational' END AS health,
    (SELECT count(*) FROM incidents i WHERE i.service_id=s.id AND i.status!='resolved') AS active_incidents
    FROM services s ORDER BY s.name`).all()));
  app.post("/api/services",canWrite,(req:AuthRequest,res)=>{
    if (req.user?.role!=="admin") throw new HttpError(403,"Only administrators can create services");
    const data=z.object({name:z.string().trim().min(3).max(60),description:z.string().trim().min(8).max(300),owner:z.string().trim().min(2).max(60)}).strict().parse(req.body);
    if (db.prepare("SELECT id FROM services WHERE name=?").get(data.name)) throw new HttpError(409,"A service with this name already exists");
    const id=randomUUID(); db.prepare("INSERT INTO services VALUES(?,?,?,?)").run(id,data.name,data.description,data.owner);
    res.status(201).json({id,...data});
  });
  app.get("/api/incidents",(req,res)=>{
    const query=z.object({
      q:z.string().max(100).default(""),
      status:z.enum(["all","open","investigating","monitoring","resolved"]).default("all"),
      severity:z.enum(["all","critical","high","medium","low"]).default("all"),
      page:z.coerce.number().int().min(1).max(100000).default(1),
    }).parse(req.query);
    const where=" WHERE (?='all' OR i.status=?) AND (?='all' OR i.severity=?) AND (i.title LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')";
    const term="%"+query.q.replace(/[\\%_]/g,"\\$&")+"%";
    const params=[query.status,query.status,query.severity,query.severity,term,term];
    const total=(db.prepare("SELECT count(*) AS total FROM incidents i JOIN services s ON s.id=i.service_id"+where).get(...params) as {total:number}).total;
    const items=db.prepare(baseSelect+where+" ORDER BY i.created_at DESC, i.number DESC LIMIT 10 OFFSET ?").all(...params,(query.page-1)*10);
    res.json({items,total,page:query.page,pageSize:10});
  });
  app.get("/api/overview",(_req,res)=>{
    const counts=db.prepare(`SELECT
      count(*) AS total,
      sum(CASE WHEN status!='resolved' THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN status!='resolved' AND severity='critical' THEN 1 ELSE 0 END) AS critical,
      sum(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
      avg(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at)-julianday(created_at))*1440 END) AS mttr
      FROM incidents`).get();
    const daily=db.prepare(`WITH RECURSIVE days(day) AS (
      SELECT date('now','-6 days') UNION ALL SELECT date(day,'+1 day') FROM days WHERE day<date('now')
    ) SELECT day,(SELECT count(*) FROM incidents WHERE date(created_at)=day) AS count FROM days`).all();
    res.json({counts,daily});
  });
  app.post("/api/incidents",canWrite,(req:AuthRequest,res)=>{
    const data=incidentInput.parse(req.body);
    if (!db.prepare("SELECT id FROM services WHERE id=?").get(data.serviceId)) throw new HttpError(400,"Select a valid service");
    const id=randomUUID(),now=new Date().toISOString();
    transaction(db,()=>{
      const number=(db.prepare("SELECT coalesce(max(number),0)+1 AS n FROM incidents").get() as {n:number}).n;
      db.prepare("INSERT INTO incidents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,number,data.title,data.description,data.severity,"open",data.serviceId,null,req.user!.id,now,now,null,1);
      db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(randomUUID(),id,req.user!.id,"created","Incident reported",now);
    });
    res.status(201).json(db.prepare(baseSelect+" WHERE i.id=?").get(id));
  });
  app.get("/api/incidents/:id",(req,res)=>{
    const incident=db.prepare(baseSelect+" WHERE i.id=?").get(String(req.params.id));
    if (!incident) throw new HttpError(404,"Incident not found");
    const events=db.prepare("SELECT e.*,u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor_id WHERE incident_id=? ORDER BY e.created_at,e.rowid").all(String(req.params.id));
    res.json({incident,events});
  });
  app.patch("/api/incidents/:id",canWrite,(req:AuthRequest,res)=>{
    const data=z.object({version:z.number().int().positive(),status:z.enum(["open","investigating","monitoring","resolved"]).optional(),assigneeId:z.string().nullable().optional()}).strict().refine(x=>x.status!==undefined || x.assigneeId!==undefined,"Provide a change").parse(req.body);
    const id=String(req.params.id);
    transaction(db,()=>{
      const incident=db.prepare("SELECT * FROM incidents WHERE id=?").get(id) as {version:number;status:string;assignee_id:string|null}|undefined;
      if (!incident) throw new HttpError(404,"Incident not found");
      if (incident.version!==data.version) throw new HttpError(409,"This incident changed. Refresh and try again.");
      if (data.status && data.status!==incident.status && !transitionMap[incident.status].includes(data.status)) throw new HttpError(422,"Invalid status transition");
      const assignee=data.assigneeId===undefined?incident.assignee_id:data.assigneeId;
      if (assignee && !db.prepare("SELECT id FROM users WHERE id=? AND role!='viewer'").get(assignee)) throw new HttpError(400,"Assignee must be a responder or administrator");
      const now=new Date().toISOString(),status=data.status || incident.status;
      db.prepare("UPDATE incidents SET status=?,assignee_id=?,updated_at=?,resolved_at=CASE WHEN ?='resolved' THEN coalesce(resolved_at,?) ELSE NULL END,version=version+1 WHERE id=?").run(status,assignee,now,status,now,id);
      if (status!==incident.status) db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(randomUUID(),id,req.user!.id,"status","Status changed from "+incident.status+" to "+status,now);
      if (assignee!==incident.assignee_id) db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(randomUUID(),id,req.user!.id,"assignment",assignee?"Incident assigned to "+(db.prepare("SELECT name FROM users WHERE id=?").get(assignee) as {name:string}).name:"Assignee removed",now);
    });
    res.json(db.prepare(baseSelect+" WHERE i.id=?").get(id));
  });
  app.post("/api/incidents/:id/comments",canWrite,(req:AuthRequest,res)=>{
    const {body}=z.object({body:z.string().trim().min(2).max(2000)}).strict().parse(req.body);
    const id=String(req.params.id);
    if (!db.prepare("SELECT id FROM incidents WHERE id=?").get(id)) throw new HttpError(404,"Incident not found");
    const event={id:randomUUID(),incident_id:id,actor_id:req.user!.id,kind:"comment",body,created_at:new Date().toISOString()};
    db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)").run(event.id,id,event.actor_id,event.kind,event.body,event.created_at);
    res.status(201).json(event);
  });
  app.use("/api",(_req,_res)=>{throw new HttpError(404,"Endpoint not found");});
  app.use((error:unknown,req:Request,res:Response,_next:NextFunction)=>{
    if (error instanceof z.ZodError) { res.status(400).json({error:error.issues[0]?.message || "Invalid request",requestId:res.getHeader("X-Request-Id")}); return; }
    const status=error instanceof HttpError?error.status:(error as {status?:number}).status === 400?400:500;
    if (status===500) console.error(JSON.stringify({level:"error",requestId:res.getHeader("X-Request-Id"),method:req.method,path:req.path,error:String(error)}));
    res.status(status).json({error:status===500?"Unexpected server error":error instanceof Error?error.message:"Bad request",requestId:res.getHeader("X-Request-Id")});
  });
  return app;
}



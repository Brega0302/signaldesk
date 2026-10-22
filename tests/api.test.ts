import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { openDatabase, seedDemo } from "../server/db.ts";
import { createApp } from "../server/app.ts";

const db=openDatabase(":memory:");
seedDemo(db);
let server:Server,base:string;
before(async()=>{server=createServer(createApp(db));server.listen(0,"127.0.0.1");await once(server,"listening");base="http://127.0.0.1:"+(server.address() as {port:number}).port;});
after(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();});
async function request(path:string,method="GET",body?:unknown,cookie?:string,headers:Record<string,string>={}){
  return fetch(base+"/api"+path,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
async function login(role="admin"){
  const response=await request("/auth/login","POST",{email:role+"@signaldesk.demo",password:"DemoPass123!"});
  assert.equal(response.status,200);
  const cookie=response.headers.get("set-cookie")!;
  assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Strict/i);
  return cookie.split(";")[0];
}
const incident={title:"Integration test incident",description:"A meaningful incident description for an API integration test.",severity:"high",serviceId:"api"};

test("authentication protects data, rotates sessions, and logout revokes them",async()=>{
  assert.equal((await request("/incidents")).status,401);
  assert.equal((await request("/auth/login","POST",{email:"admin@signaldesk.demo",password:"wrong"})).status,401);
  const first=await login();
  const rotated=await request("/auth/login","POST",{email:"admin@signaldesk.demo",password:"DemoPass123!"},first);
  const second=rotated.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await request("/auth/me","GET",undefined,first)).status,401);
  assert.equal((await request("/auth/me","GET",undefined,second)).status,200);
  assert.equal((await request("/auth/logout","POST",{},second)).status,204);
  assert.equal((await request("/auth/me","GET",undefined,second)).status,401);
});
test("viewer cannot bypass the interface to mutate data; responder cannot register services",async()=>{
  const viewer=await login("viewer");
  assert.equal((await request("/incidents","POST",incident,viewer)).status,403);
  const list=await(await request("/incidents","GET",undefined,viewer)).json();
  assert.equal((await request("/incidents/"+list.items[0].id,"PATCH",{version:1,status:"investigating"},viewer)).status,403);
  assert.equal((await request("/incidents/"+list.items[0].id+"/comments","POST",{body:"Bypass attempt"},viewer)).status,403);
  const responder=await login("responder");
  assert.equal((await request("/services","POST",{name:"New service",description:"A valid description",owner:"Platform"},responder)).status,403);
});
test("incident lifecycle rejects invalid transitions and stale writes without orphan audit events",async()=>{
  const cookie=await login("responder");
  const response=await request("/incidents","POST",incident,cookie);assert.equal(response.status,201);
  const created=await response.json();
  assert.equal(created.version,1);assert.equal(created.status,"open");
  const url="/incidents/"+created.id;
  assert.equal((await request(url,"PATCH",{version:1,status:"resolved"},cookie)).status,422);
  const updated=await request(url,"PATCH",{version:1,status:"investigating",assigneeId:"responder"},cookie);assert.equal(updated.status,200);
  assert.equal((await updated.json()).version,2);
  assert.equal((await request(url,"PATCH",{version:1,status:"monitoring"},cookie)).status,409);
  let detail=await(await request(url,"GET",undefined,cookie)).json();
  assert.equal(detail.events.length,3);
  assert.equal(detail.incident.status,"investigating");
  assert.equal((await request(url,"PATCH",{version:2,status:"monitoring"},cookie)).status,200);
  assert.equal((await request(url,"PATCH",{version:3,status:"resolved"},cookie)).status,200);
  detail=await(await request(url,"GET",undefined,cookie)).json();
  assert.ok(detail.incident.resolved_at);
  assert.equal((await request(url,"PATCH",{version:4,status:"open"},cookie)).status,200);
  detail=await(await request(url,"GET",undefined,cookie)).json();assert.equal(detail.incident.resolved_at,null);
});
test("validation rejects bad foreign keys, viewer assignment and malformed input",async()=>{
  const cookie=await login();
  assert.equal((await request("/incidents","POST",{...incident,title:"x"},cookie)).status,400);
  assert.equal((await request("/incidents","POST",{...incident,serviceId:"missing"},cookie)).status,400);
  assert.equal((await request("/incidents","POST",{...incident,unexpected:"field"},cookie)).status,400);
  const created=await(await request("/incidents","POST",incident,cookie)).json();
  assert.equal((await request("/incidents/"+created.id,"PATCH",{version:1,assigneeId:"viewer"},cookie)).status,400);
  assert.equal((await request("/incidents?page=0","GET",undefined,cookie)).status,400);
});
test("comments are attributed to the session; search handles injection characters as data",async()=>{
  const cookie=await login();
  const created=await(await request("/incidents","POST",{...incident,title:"Unique search incident"},cookie)).json();
  const comment=await request("/incidents/"+created.id+"/comments","POST",{body:"Investigated the primary database connection pool."},cookie);
  assert.equal(comment.status,201);
  const detail=await(await request("/incidents/"+created.id,"GET",undefined,cookie)).json();
  assert.equal(detail.events.at(-1).actor_name,"Alex Morgan");
  const filtered=await(await request("/incidents?q=Unique%20search","GET",undefined,cookie)).json();
  assert.equal(filtered.total,1);
  assert.equal(filtered.items[0].id,created.id);
  const injection=await(await request("/incidents?q="+encodeURIComponent("' OR 1=1 --"),"GET",undefined,cookie)).json();
  assert.equal(injection.total,0);
  const wildcard=await(await request("/incidents?q=%25","GET",undefined,cookie)).json();
  assert.equal(wildcard.total,0);
});
test("service health and MTTR derive from stored incidents, not UI state",async()=>{
  const cookie=await login();
  const added=await request("/services","POST",{name:"Isolated test service",description:"Service for metric integrity verification",owner:"Test team"},cookie);
  assert.equal(added.status,201);
  const service=await added.json();
  const created=await(await request("/incidents","POST",{...incident,severity:"critical",serviceId:service.id},cookie)).json();
  const services=await(await request("/services","GET",undefined,cookie)).json();
  assert.equal(services.find((s:{id:string})=>s.id===service.id).health,"outage");
  for(const[version,status]of [[1,"investigating"],[2,"monitoring"],[3,"resolved"]]as const)assert.equal((await request("/incidents/"+created.id,"PATCH",{version,status},cookie)).status,200);
  const resolved=await(await request("/services","GET",undefined,cookie)).json();
  assert.equal(resolved.find((s:{id:string})=>s.id===service.id).health,"operational");
  const metrics=await(await request("/overview","GET",undefined,cookie)).json();
  assert.equal(metrics.daily.length,7);assert.ok(metrics.counts.mttr>=0);
});
test("cross-site writes and form content types are rejected",async()=>{
  const cookie=await login();
  assert.equal((await request("/incidents","POST",incident,cookie,{Origin:"https://evil.example"})).status,403);
  assert.equal((await request("/incidents","POST",incident,cookie,{"Sec-Fetch-Site":"cross-site"})).status,403);
  assert.equal((await request("/incidents","POST",incident,cookie,{"Content-Type":"text/plain"})).status,415);
});
test("transaction rolls back both incident update and audit when event persistence fails",async()=>{
  const cookie=await login();
  const incident=await(await request("/incidents","POST",{title:"Atomic rollback verification",description:"Verify that failed audit storage cannot leave a partial status change.",severity:"low",serviceId:"web"},cookie)).json();
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON events WHEN NEW.kind='status' BEGIN SELECT RAISE(ABORT,'simulated event storage failure'); END;");
  try {
    const response=await request("/incidents/"+incident.id,"PATCH",{version:1,status:"investigating"},cookie);
    assert.equal(response.status,500);
    const detail=await(await request("/incidents/"+incident.id,"GET",undefined,cookie)).json();
    assert.equal(detail.incident.status,"open");assert.equal(detail.incident.version,1);assert.equal(detail.events.length,1);
  } finally { db.exec("DROP TRIGGER fail_audit;"); }
});
test("login rate limiting activates and returns Retry-After",async()=>{
  for(let i=0;i<10;i++)assert.equal((await request("/auth/login","POST",{email:"nobody@example.com",password:"wrong"})).status,401);
  const blocked=await request("/auth/login","POST",{email:"nobody@example.com",password:"wrong"});
  assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get("retry-after"))>0);
});



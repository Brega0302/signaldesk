import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, seedDemo } from "./db.ts";
import { createApp } from "./app.ts";

// Node 22 loads .env without a third-party parser.
if (existsSync(".env")) process.loadEnvFile(".env");
const db = openDatabase(process.env.DATABASE_PATH || "./data/signaldesk.sqlite");
if (process.env.SEED_DEMO === "true") seedDemo(db);
const app = createApp(db,{secureCookie:process.env.COOKIE_SECURE==="true"});
const dist=resolve("dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*path}",(_req,res)=>res.sendFile(resolve(dist,"index.html")));
}
const server=app.listen(Number(process.env.PORT || 3010),process.env.HOST || "127.0.0.1",()=>console.log("SignalDesk API ready on port "+(process.env.PORT || 3010)));
function shutdown(){server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);


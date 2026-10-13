import service from "./service.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";

// ---- config: bearer token arrives via the service input schema (bound to the
// MCP_AUTH_TOKEN platform secret at provision time). Never hardcoded.
const input = service.input() as { mcpAuthToken: { expose(): string } };
const TOKEN = input.mcpAuthToken.expose();
if (!TOKEN) console.warn("[phone-bridge] WARNING: no MCP auth token configured");

const NOTES_DIR = "/tmp/notes";
await mkdir(NOTES_DIR, { recursive: true });

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization || "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function mcp(): McpServer {
  const server = new McpServer({ name: "phone-bridge", version: "1.0.0" });

  server.registerTool(
    "run_js",
    {
      description:
        "Execute JavaScript/TypeScript code in a subprocess (Bun) and return stdout/stderr. Use for computation, data processing, scripting.",
      inputSchema: {
        code: z.string().describe("JS/TS code to execute. Top-level await allowed."),
      },
    },
    async ({ code }) => {
      const proc = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exit = await proc.exited;
      const text = `exit=${exit}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`;
      return { content: [{ type: "text", text: text.slice(0, 20000) }] };
    }
  );

  server.registerTool(
    "web_fetch",
    {
      description: "Fetch a URL and return its text content (truncated).",
      inputSchema: {
        url: z.string().url(),
        maxChars: z.number().int().min(100).max(50000).default(8000),
      },
    },
    async ({ url, maxChars }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25000);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { "user-agent": "phone-bridge/1.0" },
        });
        const text = await res.text();
        return {
          content: [{ type: "text", text: `status=${res.status}\n${text.slice(0, maxChars)}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `fetch failed: ${e?.message || e}` }] };
      } finally {
        clearTimeout(t);
      }
    }
  );

  server.registerTool(
    "notes_write",
    {
      description: "Save a named note (markdown/text) on the server.",
      inputSchema: { name: z.string(), content: z.string() },
    },
    async ({ name, content }) => {
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      await writeFile(join(NOTES_DIR, safe + ".md"), content, "utf8");
      return { content: [{ type: "text", text: `saved note: ${safe}` }] };
    }
  );

  server.registerTool(
    "notes_read",
    {
      description: "Read a named note back.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      try {
        const content = await readFile(join(NOTES_DIR, safe + ".md"), "utf8");
        return { content: [{ type: "text", text: content.slice(0, 20000) }] };
      } catch {
        return { content: [{ type: "text", text: `note not found: ${safe}` }] };
      }
    }
  );

  server.registerTool(
    "notes_list",
    { description: "List saved note names.", inputSchema: {} },
    async () => {
      const files = await readdir(NOTES_DIR).catch(() => []);
      return {
        content: [
          { type: "text", text: files.map((f) => f.replace(/\.md$/, "")).join("\n") || "(none)" },
        ],
      };
    }
  );

  registerPiTools(server);

  return server;
}

// ---- pi task queue: phone agent submits via MCP, cloud VM claims via HTTP ----
const TASKS_DIR = "/tmp/pi-tasks";
await mkdir(TASKS_DIR, { recursive: true });

type PiTask = {
  id: string;
  task: string;
  session_id: string;
  status: "pending" | "running" | "done";
  output?: string;
  ok?: boolean;
  created_at: string;
  claimed_at?: string;
  done_at?: string;
};

async function loadTask(id: string): Promise<PiTask | null> {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  if (!safe) return null;
  try {
    return JSON.parse(await readFile(join(TASKS_DIR, safe + ".json"), "utf8"));
  } catch {
    return null;
  }
}

async function saveTask(t: PiTask): Promise<void> {
  await writeFile(join(TASKS_DIR, t.id + ".json"), JSON.stringify(t), "utf8");
}

async function submitPiTask(task: string, session_id: string): Promise<PiTask> {
  const t: PiTask = {
    id: randomUUID(),
    task: task.slice(0, 8000),
    session_id: (session_id || "").slice(0, 128),
    status: "pending",
    created_at: new Date().toISOString(),
  };
  await saveTask(t);
  return t;
}

function webAuthed(url: URL): boolean {
  const tok = url.searchParams.get("token") || "";
  const a = Buffer.from(tok);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const PI_DASH_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Pi Remote</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#f6f1e7;color:#3a3428;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;max-width:640px;margin:0 auto;height:100dvh}
header{padding:12px 14px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e8dfc9;background:#f6f1e7;position:sticky;top:0;z-index:2}
h1{font-size:18px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#4caf50;margin-right:7px;vertical-align:1px}
#newsess{background:none;border:1px solid #d8cba4;color:#8a7a55;border-radius:20px;padding:6px 12px;font-size:13px;width:auto;margin:0}
#chat{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:88%;padding:10px 13px;border-radius:16px;font-size:15px;line-height:1.55;white-space:pre-wrap;word-break:break-word;animation:pop .28s cubic-bezier(.2,1.6,.4,1)}
@keyframes pop{from{transform:scale(.92) translateY(6px);opacity:0}to{transform:none;opacity:1}}
.user{align-self:flex-end;background:#b9792f;color:#fff;border-bottom-right-radius:6px}
.pi{align-self:flex-start;background:#fffdf7;border:1px solid #e8dfc9;border-bottom-left-radius:6px;box-shadow:0 2px 8px rgba(120,100,60,.07)}
.pi pre{background:#2e2a24;color:#e8e2d2;border-radius:8px;padding:8px;font-size:12.5px;overflow:auto;max-height:260px;margin-top:6px;font-family:monospace;white-space:pre-wrap}
.working{align-self:flex-start;background:#fffdf7;border:1px solid #e8dfc9;border-radius:16px;border-bottom-left-radius:6px;padding:10px 14px;font-size:14px;color:#8a7a55}
.working span{display:inline-block;animation:blink 1.2s infinite}
.working span:nth-child(2){animation-delay:.2s}.working span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,60%,100%{opacity:.2}30%{opacity:1}}
#bar{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid #e8dfc9;background:#f6f1e7}
#in{flex:1;border:1px solid #ddd2b8;border-radius:22px;padding:11px 14px;font-size:15px;background:#fffdf7;color:#3a3428;font-family:inherit;resize:none;max-height:120px}
#send{background:#b9792f;color:#fff;border:0;border-radius:50%;width:46px;height:46px;font-size:18px;flex-shrink:0}
#send:active{transform:scale(.93)}
.meta{font-size:11px;color:#b3ab97;margin-top:4px}
</style></head><body>
<header><h1><span class="dot"></span>Pi</h1><button id="newsess" onclick="newSession()">新会话</button></header>
<div id="chat"></div>
<div id="bar"><textarea id="in" rows="1" placeholder="跟 pi 说点什么…"></textarea><button id="send" onclick="send()">➤</button></div>
<script>
const token=new URLSearchParams(location.search).get("token")||"";
let sid=localStorage.getItem("pi_sid")||crypto.randomUUID();
localStorage.setItem("pi_sid",sid);
function newSession(){sid=crypto.randomUUID();localStorage.setItem("pi_sid",sid);load(true);}
const api=(p,o)=>fetch(p+"?token="+encodeURIComponent(token),o).then(r=>r.json());
const esc=s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;");
let lastCount=-1;
async function load(force){
  const ts=(await api("/pi/tasks")).filter(t=>t.session_id===sid).sort((a,b)=>a.created_at<b.created_at?-1:1);
  const el=document.getElementById("chat");
  if(ts.length===lastCount&&!force)return;
  const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<120;
  lastCount=ts.length;
  let h=ts.map(t=>{
    let m='<div class="msg user">'+esc(t.task)+'</div>';
    if(t.status==="done")m+='<div class="msg pi">'+esc((t.output||"").slice(0,6000)).replace(/\\n/g,"<br>")+'</div>';
    return m;
  }).join("");
  const working=ts.length&&ts[ts.length-1].status!=="done";
  if(working)h+='<div class="working">pi 正在工作<span>.</span><span>.</span><span>.</span></div>';
  if(!ts.length)h='<div class="msg pi">我是 pi，在云电脑上跑。直接跟我说要干什么，比如：看看 ~/workspace/agentdeck 里都有什么。</div>';
  el.innerHTML=h;
  if(nearBottom||force)el.scrollTop=el.scrollHeight;
}
async function send(){
  const v=document.getElementById("in").value.trim();if(!v)return;
  document.getElementById("in").value="";
  await api("/pi/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({task:v,session_id:sid})});
  load(true);
}
document.getElementById("in").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
load(true);setInterval(()=>load(false),4000);
</script></body></html>`;

function registerPiTools(server: McpServer): void {
  server.registerTool(
    "pi_task_submit",
    {
      description:
        "Submit a task for the pi coding agent running on the cloud VM. Returns a task_id; poll pi_task_status for the result. Tasks are ephemeral: if the bridge restarts mid-task, the task is lost and must be resubmitted.",
      inputSchema: {
        task: z.string().describe("What pi should do (coding task description)"),
        session_id: z
          .string()
          .optional()
          .describe("Continue a previous pi session; omit to start a new one"),
      },
    },
    async ({ task, session_id }) => {
      const t = await submitPiTask(task, session_id || "");
      return { content: [{ type: "text", text: `task_id=${t.id}` }] };
    }
  );

  server.registerTool(
    "pi_task_status",
    {
      description:
        "Check a pi task's status (pending/running/done). When done, includes the agent's output.",
      inputSchema: { task_id: z.string() },
    },
    async ({ task_id }) => {
      const t = await loadTask(task_id);
      if (!t)
        return {
          content: [
            {
              type: "text",
              text: "task not found (it may have expired after a bridge restart — resubmit)",
            },
          ],
        };
      let text = `status=${t.status}`;
      if (t.status === "done") text += `\n--- output ---\n${(t.output || "").slice(0, 20000)}`;
      return { content: [{ type: "text", text }] };
    }
  );
}

async function handlePiHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname === "/pi/claim" && req.method === "POST") {
    if (!authed(req)) {
      res.writeHead(401);
      res.end("unauthorized");
      return true;
    }
    const files = await readdir(TASKS_DIR).catch(() => [] as string[]);
    let picked: PiTask | null = null;
    const now = Date.now();
    const STALE_MS = 15 * 60 * 1000; // a claim older than this means the runner died
    for (const f of files.sort()) {
      const t = await loadTask(f.replace(/\.json$/, ""));
      if (!t) continue;
      if (t.status === "running" && t.claimed_at && now - Date.parse(t.claimed_at) > STALE_MS) {
        t.status = "pending"; // stale claim: runner died mid-task, requeue
        delete t.claimed_at;
        await saveTask(t);
      }
      if (t.status === "pending" && (!picked || t.created_at < picked.created_at))
        picked = t;
    }
    if (!picked) {
      res.writeHead(204);
      res.end();
      return true;
    }
    picked.status = "running";
    picked.claimed_at = new Date().toISOString();
    await saveTask(picked);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: picked.id, task: picked.task, session_id: picked.session_id }));
    return true;
  }
  if (url.pathname === "/pi/result" && req.method === "POST") {
    if (!authed(req)) {
      res.writeHead(401);
      res.end("unauthorized");
      return true;
    }
    let body: any;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return true;
    }
    const t = await loadTask(String(body?.task_id || ""));
    if (!t) {
      res.writeHead(404);
      res.end("task not found");
      return true;
    }
    t.status = "done";
    t.ok = !!body?.ok;
    t.output = String(body?.output || "").slice(0, 60000);
    t.done_at = new Date().toISOString();
    await saveTask(t);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}

const port = service.port();

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url || "/", "http://internal");
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "phone-bridge-prisma" }));
      return;
    }
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("method not allowed");
        return;
      }
      if (!authed(req)) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      const server = mcp();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (url.pathname.startsWith("/pi/")) {
      if (await handlePiHttp(req, res, url)) return;
    }
    // ---- pi web dashboard (token via ?token=, same bearer as MCP) ----
    if (url.pathname === "/pi" || url.pathname === "/pi/") {
      if (!webAuthed(url)) {
        res.writeHead(401);
        res.end("unauthorized: add ?token=YOUR_MCP_BEARER_TOKEN");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PI_DASH_HTML);
      return;
    }
    if (url.pathname === "/pi/tasks" && req.method === "GET") {
      if (!webAuthed(url)) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      const files = await readdir(TASKS_DIR).catch(() => [] as string[]);
      const tasks: PiTask[] = [];
      for (const f of files) {
        const t = await loadTask(f.replace(/\.json$/, ""));
        if (t) tasks.push(t);
      }
      tasks.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(tasks.slice(0, 30)));
      return;
    }
    if (url.pathname === "/pi/submit" && req.method === "POST") {
      if (!webAuthed(url)) {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      let body: any;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      const t = await submitPiTask(String(body?.task || ""), String(body?.session_id || ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ task_id: t.id }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e: any) {
    console.error("request failed:", e?.message);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("internal error");
    }
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`[phone-bridge] listening on 0.0.0.0:${port}`);
});

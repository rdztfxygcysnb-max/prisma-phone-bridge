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
      const t: PiTask = {
        id: randomUUID(),
        task: task.slice(0, 8000),
        session_id: (session_id || "").slice(0, 128),
        status: "pending",
        created_at: new Date().toISOString(),
      };
      await saveTask(t);
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
    for (const f of files.sort()) {
      const t = await loadTask(f.replace(/\.json$/, ""));
      if (t && t.status === "pending" && (!picked || t.created_at < picked.created_at))
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

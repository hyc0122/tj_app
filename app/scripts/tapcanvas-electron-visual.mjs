import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(root, "web/dist/tapcanvas");
const outDir = path.join(root, ".local/tapcanvas-visual");
const electronPath = require(path.join(root, "app/node_modules/electron"));
const mainPath = path.join(root, "app/test/tianjiang/helpers/tapcanvas-electron-visual-main.cjs");

if (!fs.existsSync(path.join(dist, "index.html"))) {
  throw new Error("缺少 web/dist/tapcanvas/index.html，请先 yarn build:tapcanvas");
}

const nodes = {
  nodes: [
    {
      id: "idea-1",
      type: "taskNode",
      position: { x: 120, y: 150 },
      data: { label: "想法", kind: "text", prompt: "黄昏海边风衣少女", nodeWidth: 360 },
    },
    {
      id: "image-1",
      type: "taskNode",
      position: { x: 540, y: 130 },
      data: { label: "画面", kind: "image", prompt: "黄昏海边风衣少女", aspectRatio: "16:9", nodeWidth: 320, modelId: "fake:image" },
    },
  ],
  edges: [{ id: "e-1", source: "idea-1", target: "image-1", type: "typed", animated: true }],
  viewport: { x: 0, y: 0, zoom: 1 },
};

const user = { sub: "visual-user", login: "tianjiang", name: "天将视觉验收" };
const models = [
  { id: 1, modelName: "fake:text", requestModelKey: "fake:text", routingAliases: [], displayLabel: "Fake Text", description: null, icon: null, tags: [], vendorId: null, endpoints: [], runtimeEndpoints: [], kind: "text", enabled: true, syncOfficial: false, nameRule: 0, createdTime: Date.now(), updatedTime: Date.now(), meta: { providerId: "fake" }, pricing: { cost: 0, enabled: true, specCosts: [] } },
  { id: 2, modelName: "fake:image", requestModelKey: "fake:image", routingAliases: [], displayLabel: "Fake Image", description: null, icon: null, tags: [], vendorId: null, endpoints: [], runtimeEndpoints: [], kind: "image", enabled: true, syncOfficial: false, nameRule: 0, createdTime: Date.now(), updatedTime: Date.now(), meta: { providerId: "fake" }, pricing: { cost: 0, enabled: true, specCosts: [] } },
];

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname.replace(/^\/api\/tianjiang\/tapcanvas/, "") || "/";
  process.stderr.write(`[tapcanvas-api] ${req.method} ${p}${url.search}\n`);
  if (req.method === "GET" && p === "/auth/session") {
    return json(res, 200, { authenticated: true, user });
  }
  if (req.method === "GET" && (p === "/projects/empty-canvas" || p === "/projects/nodes-canvas")) {
    const id = p.slice("/projects/".length);
    return json(res, 200, { id, name: id === "nodes-canvas" ? "节点画布" : "空画布", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), owner: user.login, ownerName: user.name, access: "owner", projectKind: "creative", teamShared: false });
  }
  if (req.method === "GET" && p === "/projects") {
    const items = [
      { id: "empty-canvas", name: "空画布", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), owner: user.login, ownerName: user.name, access: "owner", projectKind: "creative", teamShared: false },
      { id: "nodes-canvas", name: "节点画布", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), owner: user.login, ownerName: user.name, access: "owner", projectKind: "creative", teamShared: false },
    ];
    return json(res, 200, url.searchParams.get("limit") ? { items, nextCursor: null } : items);
  }
  if (req.method === "GET" && p === "/flows") {
    const projectId = url.searchParams.get("projectId") || "";
    const data = projectId === "nodes-canvas" ? nodes : { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    return json(res, 200, [{ id: projectId, name: "画布", ownerType: "project", ownerId: projectId, data, revision: 1 }]);
  }
  if (req.method === "GET" && p.startsWith("/flows/")) {
    const id = p.slice("/flows/".length);
    const data = id === "nodes-canvas" || id === "empty-canvas"
      ? (id === "nodes-canvas" ? nodes : { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })
      : { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    return json(res, 200, { id, name: "画布", ownerType: "project", ownerId: id, data, revision: 1 });
  }
  if (req.method === "GET" && p === "/new-api-models") return json(res, 200, models);
  if (req.method === "GET" && p === "/projects/public") return json(res, 200, []);
  if (req.method === "GET" && p === "/auth/generation-preferences") return json(res, 200, { prefs: null });
  if (req.method === "GET" && p.endsWith("/canvas-events")) return json(res, 200, { items: [] });
  if (req.method === "GET" && p === "/executions") return json(res, 200, { items: [] });
  if (req.method === "GET" && p === "/tasks/inbox") return json(res, 200, { items: [], unreadCount: 0, nextCursor: null, hasMore: false });
  if (req.method === "GET" && p === "/codex/bridges") return json(res, 200, { items: [] });
  if (req.method === "GET" && p === "/codex/tasks") return json(res, 200, { items: [] });
  if (req.method === "GET" && p.startsWith("/agents/")) return json(res, 200, { items: [], productName: "Agent 配置", candidates: [], attachments: [], skills: [], builtInCapabilities: [], currentProject: null, workflowProjects: [], invocations: [] });
  if (req.method === "GET" && p === "/new-api-models/readiness") {
    return json(res, 200, {
      ready: true, enabledModelCount: 2, configuredChannelCount: 1, executableModelCount: 2, reasons: [],
      setupUrl: "http://127.0.0.1/tianjiang-local",
      recommendedProvider: { name: "fake", baseUrl: "http://127.0.0.1/tianjiang-local", registerUrl: "http://127.0.0.1/tianjiang-local", topupUrl: "http://127.0.0.1/tianjiang-local", tokenUrl: "http://127.0.0.1/tianjiang-local" },
    });
  }
  if (req.method === "GET" && p === "/project-directory") {
    const now = Date.now();
    return json(res, 200, {
      assetId: "dir-1",
      updatedAt: new Date().toISOString(),
      state: { version: 1, rootId: "root", nodesById: { root: { id: "root", kind: "folder", parentId: null, name: "项目", createdAt: now, updatedAt: now } } },
    });
  }
  if (req.method === "PUT" && p === "/project-directory") {
    const body = await readJsonBody(req);
    return json(res, 200, {
      assetId: String(body.assetId || "dir-1"),
      updatedAt: new Date().toISOString(),
      state: body.state,
    });
  }
  if (req.method === "GET" && p === "/assets") return json(res, 200, { items: [], cursor: null });
  if (req.method === "GET" && p === "/public/projects") return json(res, 200, []);
  if (req.method === "GET" && p === "/teams/me") return json(res, 404, { error: "team_disabled" });
  if (req.method === "GET" && (p === "/account/overview" || p.endsWith("/account/overview"))) {
    return json(res, 200, {
      profile: { id: user.sub, login: user.login, name: user.name, avatarUrl: null, bio: null, email: null, phone: null, guest: false, createdAt: new Date().toISOString() },
      credits: { balance: 0, frozen: 0 },
      unreadCount: 0,
      membership: { enabled: false, configured: false, current: null, plans: [] },
      guestRestricted: false,
      checkIn: null,
    });
  }
  if (req.method === "POST" && p === "/public/tasks") return json(res, 409, { code: "confirmation_required", confirmationUuid: "visual-confirm", fee: { displayText: "可能产生费用，请确认后执行" }, message: "收费任务必须先预览并确认" });
  if (req.method === "GET") return json(res, 200, []);
  return json(res, 200, { ok: true, provider: "fake" });
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function handleStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  let relative = url.pathname.replace(/^\/tapcanvas\/?/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const file = path.resolve(dist, relative);
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "content-type": contentType(file) });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  fs.createReadStream(path.join(dist, "index.html")).pipe(res);
}

const server = createServer((req, res) => {
  if (req.url.startsWith("/api/tianjiang/tapcanvas")) return void handleApi(req, res);
  if (req.url.startsWith("/tapcanvas")) return handleStatic(req, res);
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;

const child = spawn(electronPath, [mainPath], {
  cwd: root,
  env: {
    ...process.env,
    TAPCANVAS_VISUAL_ORIGIN: origin,
    TAPCANVAS_VISUAL_OUT: outDir,
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: false,
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`Electron 视觉验收超时：${stderr}`));
  }, 120_000);
  child.on("error", reject);
  child.on("exit", (exitCode) => {
    clearTimeout(timer);
    resolve(exitCode ?? 1);
  });
});

server.close();
if (code !== 0) {
  process.stderr.write(stderr);
  throw new Error(`Electron 视觉验收退出码 ${code}`);
}
process.stdout.write(stdout || JSON.stringify({ origin, outDir }));
process.stdout.write("\n");

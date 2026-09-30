// Agent Office — local server
// Receives Claude Code hook events over HTTP, keeps a live picture of every
// session, and streams it to the browser. No dependencies: `node server.js`.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 4242;
const HOST = "127.0.0.1"; // local only — never expose this without auth
const PUBLIC_DIR = path.join(__dirname, "public");
// Optional read-only view for sharing: `PUBLIC_PORT=4243 node server.js`, then
// put a tunnel (cloudflared, ngrok) in front of it. Serves only the page and a
// redacted stream: no prompts, replies, commands, file names, paths or rulebook.
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 0;
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");

const ASLEEP_AFTER_MS = 10 * 60 * 1000; // no events for 10 min -> dozes off
const GONE_AFTER_MS = 60 * 60 * 1000; // no events for 1 h -> goes home
const LEAVE_ANIMATION_MS = 6000;
const FEED_LIMIT = 60;
// Only answer requests addressed to this machine by this page. Blocks other
// websites from posting fake events, and DNS-rebinding pages from reading the stream.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const EXPECTED_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUseFailure",
  "PermissionRequest", "Notification", "Stop", "SubagentStart",
  "SubagentStop", "PreCompact", "InstructionsLoaded", "SessionEnd",
];

fs.mkdirSync(LOG_DIR, { recursive: true });
// Payloads include whole files from Write/Edit, so start a fresh log each run
// and keep only the previous one.
try { fs.renameSync(LOG_FILE, path.join(LOG_DIR, "events.old.jsonl")); } catch { /* no log yet */ }

/** session_id -> worker state */
const sessions = new Map();
/** hook_event_name -> count, for the hook audit */
const eventCounts = Object.fromEntries(EXPECTED_EVENTS.map((e) => [e, 0]));
const clients = new Set();

// ---------- helpers ----------

function now() { return Date.now(); }

function projectName(cwd) {
  if (!cwd) return "unknown";
  return path.basename(cwd.replace(/[\\/]+$/, "")) || cwd;
}

function trim(text, n = 140) {
  if (!text) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Drop tag blocks the IDE and harness inject into prompts (opened file, selection, reminders, task notices). */
function cleanPrompt(text) {
  return String(text || "").replace(/<(ide_\w+|system-reminder|task-notification)>[\s\S]*?<\/\1>/g, "").trim();
}

/** Short human description of a tool call, plus which animation to play. */
function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : "");
  switch (name) {
    case "Bash": return { activity: "terminal", text: `$ ${trim(input.command, 90)}` };
    case "Read": return { activity: "read", text: `Reading ${base(input.file_path)}` };
    case "Grep": return { activity: "read", text: `Searching for "${trim(input.pattern, 40)}"` };
    case "Glob": return { activity: "read", text: `Finding files ${trim(input.pattern, 40)}` };
    case "Edit":
    case "MultiEdit": return { activity: "type", text: `Editing ${base(input.file_path)}` };
    case "Write": return { activity: "type", text: `Writing ${base(input.file_path)}` };
    case "NotebookEdit": return { activity: "type", text: `Editing ${base(input.notebook_path)}` };
    case "WebFetch": return { activity: "web", text: `Opening ${trim(input.url, 60)}` };
    case "WebSearch": return { activity: "web", text: `Searching the web: ${trim(input.query, 50)}` };
    case "Task":
    case "Agent": return { activity: "delegate", text: `Briefing an intern: ${trim(input.description, 60)}` };
    case "TodoWrite": return { activity: "type", text: "Updating the to-do list" };
    default: return { activity: "type", text: name || "Working" };
  }
}

// Flavor bubbles: a canned one-liner per tool. Never built from tool input,
// so it's safe to show in the public view too.
const QUIPS = {
  Bash: ["hold my coffee", "sudo make me a sandwich", "it works on my machine", "running it…"],
  Read: ["hmm, let me see", "who wrote this?", "reading the fine print"],
  Grep: ["where is it...", "it's here somewhere", "ctrl+F intensifies"],
  Glob: ["where is it...", "rummaging around"],
  Edit: ["fixed it (probably)", "tiny tweak", "trust me"],
  MultiEdit: ["fixed it (probably)", "a few tweaks"],
  Write: ["fresh file!", "typing furiously"],
  WebFetch: ["one sec, googling", "checking the docs"],
  WebSearch: ["one sec, googling", "to the internet!"],
  Task: ["intern! got a job", "delegating™"],
  Agent: ["intern! got a job", "delegating™"],
  TodoWrite: ["making a list", "so many todos"],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Opening a PR is the last step of "commit, push, PR". Seeing one in a turn
// means the code goes up to a higher power when the turn ends.
function opensPr(toolName, input = {}) {
  return /create_pull_request/i.test(toolName || "") ||
    (toolName === "Bash" && /\bgh\s+pr\s+create\b/.test(input.command || ""));
}

function lastLineIsQuestion(message) {
  if (!message) return false;
  const lines = String(message).trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return /\?\**\s*$/.test(last);
}

function getSession(payload) {
  const id = payload.session_id || "unknown";
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      cwd: payload.cwd || "",
      project: projectName(payload.cwd),
      host: payload._host || os.hostname(),
      permissionMode: payload.permission_mode || "default",
      status: "idle", // idle | working | waiting | done | asleep | leaving
      activity: null,
      currentText: "",
      question: null, // { kind: "permission" | "question", text }
      lastPrompt: "",
      lastMessage: "",
      interns: {}, // agent_id -> { type, text, activity }
      instructions: [],
      feed: [],
      flash: null, // { kind: "puff" | "yawn", at }
      startedAt: now(),
      lastSeen: now(),
      demo: !!payload._demo,
      // VS Code pre-warms sessions that only load instructions and may never
      // send SessionEnd. Keep them off the floor until they do real work.
      active: false,
    };
    sessions.set(id, s);
  }
  if (payload.cwd && !s.cwd) {
    s.cwd = payload.cwd;
    s.project = projectName(payload.cwd);
  }
  if (payload.permission_mode) s.permissionMode = payload.permission_mode;
  s.lastSeen = now();
  return s;
}

// The tab title VS Code shows is written into the transcript as an "ai-title"
// line (or "custom-title" once you rename the tab). Use the latest one.
// ponytail: reads the whole transcript, tail-read if long sessions get slow
function refreshTitle(s, transcriptPath) {
  if (!transcriptPath) return;
  fs.readFile(transcriptPath, "utf8", (err, text) => {
    if (err) return;
    const re = /"(?:customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/g;
    let m, last = null;
    while ((m = re.exec(text))) last = m[1];
    if (!last) return;
    try { last = JSON.parse(`"${last}"`); } catch { return; }
    if (last !== s.title) { s.title = last; broadcast(); }
  });
}

function sendHome(s) {
  s.status = "leaving";
  setTimeout(() => { sessions.delete(s.id); broadcast(); }, LEAVE_ANIMATION_MS);
}

function addFeed(s, kind, text) {
  s.feed.push({ at: now(), kind, text: trim(text, 400) });
  if (s.feed.length > FEED_LIMIT) s.feed.splice(0, s.feed.length - FEED_LIMIT);
}

// ---------- the event -> state machine ----------

function handleEvent(payload) {
  const name = payload.hook_event_name || "Unknown";
  eventCounts[name] = (eventCounts[name] || 0) + 1;
  // Don't seat a worker just to send them home.
  if (name === "SessionEnd" && !sessions.has(payload.session_id || "unknown")) return;
  const s = getSession(payload);
  if (name !== "InstructionsLoaded" && name !== "SessionEnd") s.active = true;
  const agentId = payload.agent_id; // present when the event came from a subagent

  // The ai-title is written a few seconds after the first prompt, so keep checking until one shows up.
  if (!s.title || name === "SessionStart" || name === "UserPromptSubmit" || name === "Stop") refreshTitle(s, payload.transcript_path);

  switch (name) {
    case "SessionStart":
      s.status = "idle";
      addFeed(s, "system", `Clocked in (${payload.source || "startup"})`);
      break;

    case "UserPromptSubmit": {
      s.status = "working";
      s.question = null;
      const prompt = cleanPrompt(payload.prompt);
      if (prompt) s.lastPrompt = trim(prompt, 500);
      s.openedPr = false;
      s.currentText = "Reading the brief";
      s.activity = "read";
      if (prompt) addFeed(s, "you", prompt);
      break;
    }

    case "PreToolUse": {
      const t = describeTool(payload.tool_name, payload.tool_input);
      if (opensPr(payload.tool_name, payload.tool_input)) s.openedPr = true;
      if (agentId) {
        const intern = (s.interns[agentId] ||= { type: payload.agent_type || "intern" });
        intern.text = t.text;
        intern.activity = t.activity;
        addFeed(s, "intern", `${intern.type}: ${t.text}`);
      } else {
        s.status = "working";
        s.question = null;
        s.activity = t.activity;
        s.currentText = t.text;
        s.quip = { text: pick(QUIPS[payload.tool_name] || ["on it"]), at: now() };
        addFeed(s, "tool", t.text);
      }
      break;
    }

    case "PostToolUseFailure":
      if (opensPr(payload.tool_name, payload.tool_input)) s.openedPr = false;
      s.flash = { kind: "puff", at: now() };
      addFeed(s, "error", `${payload.tool_name || "Tool"} failed`);
      break;

    case "PermissionRequest": {
      const t = describeTool(payload.tool_name, payload.tool_input);
      s.status = "waiting";
      s.question = { kind: "permission", text: `Wants permission: ${t.text}` };
      addFeed(s, "ask", s.question.text);
      break;
    }

    case "Notification":
      // Unreliable in the VS Code extension, but use it if it arrives.
      // "idle_prompt" fires a minute after every finished turn, so it isn't a real ask.
      if (payload.notification_type === "idle_prompt" || payload.notification_type === "auth_success") break;
      if (s.status !== "waiting") {
        s.status = "waiting";
        s.question = { kind: "question", text: trim(payload.message, 200) || "Needs your attention" };
        addFeed(s, "ask", s.question.text);
      }
      break;

    case "Stop": {
      const msg = payload.last_assistant_message || "";
      s.lastMessage = trim(msg, 1200);
      s.interns = {};
      s.activity = null;
      if (s.openedPr) {
        s.openedPr = false;
        s.flash = { kind: "ascend", at: now() };
        addFeed(s, "system", "PR sent. The laptop was taken up to a higher power");
      }
      if (lastLineIsQuestion(msg)) {
        s.status = "waiting";
        const lines = msg.trim().split(/\n+/).filter(Boolean);
        s.question = { kind: "question", text: trim(lines[lines.length - 1], 240) };
        addFeed(s, "ask", s.question.text);
      } else {
        s.status = "done";
        s.currentText = "Finished work, waiting for more";
        if (msg) addFeed(s, "claude", msg);
      }
      break;
    }

    case "SubagentStart": {
      const id = agentId || `intern-${now()}`;
      s.interns[id] = { type: payload.agent_type || "intern", text: "Getting set up", activity: "type" };
      addFeed(s, "intern", `An intern (${payload.agent_type || "general"}) walked over`);
      break;
    }

    case "SubagentStop":
      if (agentId && s.interns[agentId]) {
        addFeed(s, "intern", `${s.interns[agentId].type} intern handed in their work`);
        delete s.interns[agentId];
      } else {
        const first = Object.keys(s.interns)[0];
        if (first) delete s.interns[first];
      }
      break;

    case "PreCompact":
      s.flash = { kind: "yawn", at: now() };
      addFeed(s, "system", "Memory getting full — compacting context");
      break;

    case "InstructionsLoaded": {
      const p = payload.file_path || payload.path;
      if (p && !s.instructions.includes(p)) s.instructions.push(p);
      break;
    }

    case "SessionEnd":
      addFeed(s, "system", "Clocked out");
      sendHome(s);
      break;

    default:
      addFeed(s, "system", name);
  }

  broadcast();
}

// ---------- idle sweeper ----------

setInterval(() => {
  const t = now();
  let changed = false;
  for (const s of sessions.values()) {
    if (s.status === "leaving") continue;
    const idle = t - s.lastSeen;
    if (idle > GONE_AFTER_MS) {
      sendHome(s);
      changed = true;
    } else if (idle > ASLEEP_AFTER_MS && s.status !== "asleep" && s.status !== "waiting" && s.status !== "done") {
      s.status = "asleep";
      changed = true;
    }
  }
  if (changed) broadcast();
}, 30 * 1000);

// ---------- streaming to the browser (server-sent events) ----------

function snapshot() {
  return {
    watching: { host: os.hostname(), endpoint: `http://${HOST}:${PORT}/events` },
    sessions: [...sessions.values()].filter((s) => s.active),
    audit: eventCounts,
    expected: EXPECTED_EVENTS,
    serverTime: now(),
  };
}

const PUBLIC_TEXT = { terminal: "Running a command", read: "Reading", type: "Writing", web: "Browsing the web", delegate: "Briefing an intern" };
const SALT = crypto.randomBytes(8).toString("hex");
const alias = (id) => crypto.createHash("sha256").update(SALT + id).digest("hex").slice(0, 12);

/** Same office, with everything that could reveal your files stripped out. */
function publicSnapshot() {
  return {
    public: true,
    sessions: snapshot().sessions.map((s) => ({
      id: alias(s.id),
      project: s.project,
      cwd: "",
      host: "",
      permissionMode: s.permissionMode,
      status: s.status,
      activity: s.activity,
      currentText: s.status === "done" ? s.currentText : PUBLIC_TEXT[s.activity] || "",
      question: s.question && { kind: s.question.kind, text: s.question.kind === "permission" ? "Waiting for approval" : "Has a question" },
      interns: Object.fromEntries(Object.entries(s.interns).map(([k, i]) => [alias(k), { type: i.type, activity: i.activity, text: PUBLIC_TEXT[i.activity] || "Working" }])),
      feed: [],
      flash: s.flash,
      quip: s.quip,
      startedAt: s.startedAt,
      lastSeen: s.lastSeen,
      demo: s.demo,
    })),
    serverTime: now(),
  };
}

const publicClients = new Set();

function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
  if (!publicClients.size) return;
  const pub = `data: ${JSON.stringify(publicSnapshot())}\n\n`;
  for (const res of publicClients) res.write(pub);
}

function stream(req, res, set, snap) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify(snap())}\n\n`);
  set.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { clearInterval(ping); set.delete(res); });
}

// ---------- rulebook (CLAUDE.md viewer) ----------

function readIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function rulebookFor(session) {
  const files = [];
  const add = (label, p) => {
    const content = readIfExists(p);
    if (content !== null) files.push({ label, path: p, content });
  };
  if (session.cwd) {
    add("Project CLAUDE.md", path.join(session.cwd, "CLAUDE.md"));
    add("Project .claude/CLAUDE.md", path.join(session.cwd, ".claude", "CLAUDE.md"));
    add("Personal project notes (CLAUDE.local.md)", path.join(session.cwd, "CLAUDE.local.md"));
    const rulesDir = path.join(session.cwd, ".claude", "rules");
    try {
      for (const f of fs.readdirSync(rulesDir)) {
        if (f.endsWith(".md")) add(`Rule: ${f}`, path.join(rulesDir, f));
      }
    } catch { /* no rules folder */ }
  }
  add("Your global CLAUDE.md", path.join(os.homedir(), ".claude", "CLAUDE.md"));
  return { files, loaded: session.instructions };
}

// ---------- demo mode ----------

let demoTimers = [];

function runDemo() {
  if ([...sessions.values()].some((s) => s.demo)) return; // already running
  const home = os.homedir();
  const mk = (id, cwd) => ({ session_id: id, cwd, _demo: true, permission_mode: "default" });
  const a = mk("demo-cro", path.join(home, "dev", "cro-app"));
  const b = mk("demo-pool", path.join(home, "dev", "shark-pool"));
  const c = mk("demo-office", path.join(home, "dev", "agent-office"));
  const steps = [
    [0, { ...a, hook_event_name: "SessionStart", source: "startup" }],
    [600, { ...a, hook_event_name: "UserPromptSubmit", prompt: "Add read receipts to the chat screen" }],
    [1800, { ...a, hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "MessageBubble" } }],
    [2500, { ...b, hook_event_name: "SessionStart", source: "startup" }],
    [3200, { ...b, hook_event_name: "UserPromptSubmit", prompt: "Port the cue ball physics from Godot to Unity" }],
    [4200, { ...a, hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { description: "Find every place messages are marked read" } }],
    [4800, { ...a, hook_event_name: "SubagentStart", agent_id: "ag-1", agent_type: "Explore" }],
    [5200, { ...b, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "cue_ball.gd" } }],
    [6000, { ...a, hook_event_name: "PreToolUse", agent_id: "ag-1", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "ChatHub.cs" } }],
    [7000, { ...c, hook_event_name: "SessionStart", source: "startup" }],
    [7600, { ...c, hook_event_name: "UserPromptSubmit", prompt: "Make the intern sprite carry a laptop" }],
    [8200, { ...b, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "CueBall.cs" } }],
    [9200, { ...c, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } }],
    [10000, { ...c, hook_event_name: "PostToolUseFailure", tool_name: "Bash" }],
    [11000, { ...b, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "dotnet test" } }],
    [12500, { ...a, hook_event_name: "SubagentStop", agent_id: "ag-1" }],
    [13000, { ...a, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "message_bubble.dart" } }],
    [15000, { ...c, hook_event_name: "Stop", last_assistant_message: "The build fails because two sprite sheets share a name.\n\nShould I rename the intern sheet to intern_laptop.png?" }],
    [14200, { ...a, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m \"Add read receipts\"" } }],
    [15200, { ...a, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push -u origin read-receipts" } }],
    [16200, { ...a, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr create --fill" } }],
    [17000, { ...a, hook_event_name: "Stop", last_assistant_message: "Read receipts now show under each sent message. I added a `ReadAt` field and updated the hub." }],
  ];
  demoTimers = steps.map(([delay, ev]) => setTimeout(() => handleEvent(ev), delay));
}

// ---------- HTTP server ----------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => resolve(body));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!ALLOWED_HOSTS.has(req.headers.host) || (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, "")))) {
    res.writeHead(403);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Claude Code hooks POST here.
  if (req.method === "POST" && url.pathname === "/events") {
    const body = await readBody(req);
    // Answer immediately with "no decision" so Claude is never held up.
    json(res, 200, {});
    try {
      const payload = JSON.parse(body);
      fs.appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...payload }) + "\n", () => {});
      console.log(`${new Date().toLocaleTimeString()}  ${String(payload.hook_event_name).padEnd(20)} ${projectName(payload.cwd)}${payload.tool_name ? "  " + payload.tool_name : ""}`);
      handleEvent(payload);
    } catch (e) {
      console.warn("Could not parse hook payload:", e.message);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/stream") return stream(req, res, clients, snapshot);

  if (req.method === "GET" && url.pathname === "/api/rulebook") {
    const s = sessions.get(url.searchParams.get("session"));
    if (!s) return json(res, 404, { error: "That worker has left the office." });
    return json(res, 200, rulebookFor(s));
  }

  if (req.method === "POST" && url.pathname === "/api/demo") {
    runDemo();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/clear-demo") {
    demoTimers.forEach(clearTimeout);
    for (const s of sessions.values()) if (s.demo && s.status !== "leaving") sendHome(s);
    broadcast();
    return json(res, 200, { ok: true });
  }

  // Static files
  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Agent Office is open at http://${HOST}:${PORT}`);
  console.log(`  Hooks should POST to  http://${HOST}:${PORT}/events\n`);
});

// Read-only public view. Only two routes; everything else is 404.
if (PUBLIC_PORT) {
  const PUBLIC_HOST = process.env.PUBLIC_HOST || "127.0.0.1"; // tunnel connects locally
  http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (req.method !== "GET") { res.writeHead(405); return res.end(); }
    if (pathname === "/stream") return stream(req, res, publicClients, publicSnapshot);
    if (pathname !== "/") { res.writeHead(404); return res.end(); }
    fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err, data) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  }).listen(PUBLIC_PORT, PUBLIC_HOST, () => console.log(`  Public read-only view at http://${PUBLIC_HOST}:${PUBLIC_PORT}\n`));
}

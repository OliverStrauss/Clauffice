// Adds (or removes) the Agent Office HTTP hooks in ~/.claude/settings.json.
//   node install-hooks.js            -> install
//   node install-hooks.js --remove   -> uninstall
// A backup of your settings is written next to the original first.

const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT) || 4242;
const URL = `http://127.0.0.1:${PORT}/events`;
const EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUseFailure",
  "PermissionRequest", "Notification", "Stop", "SubagentStart",
  "SubagentStop", "PreCompact", "InstructionsLoaded", "SessionEnd",
];

const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const remove = process.argv.includes("--remove");

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, "utf8");
  try {
    settings = JSON.parse(raw);
  } catch {
    console.error(`Couldn't parse ${settingsPath}. Fix the JSON, then run this again.`);
    process.exit(1);
  }
  const backup = `${settingsPath}.backup-${Date.now()}`;
  fs.writeFileSync(backup, raw);
  console.log(`Backed up your settings to ${backup}`);
} else {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
}

settings.hooks ||= {};
const isOurs = (h) => h && h.type === "http" && h.url === URL;

for (const event of EVENTS) {
  const groups = (settings.hooks[event] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  if (!remove) groups.push({ hooks: [{ type: "http", url: URL, timeout: 2 }] });
  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

// If you use an HTTP hook allowlist, make sure the office is on it.
if (!remove && Array.isArray(settings.allowedHttpHookUrls) && !settings.allowedHttpHookUrls.includes(URL)) {
  settings.allowedHttpHookUrls.push(URL);
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(remove
  ? "Removed Agent Office hooks. Reload VS Code windows for it to take effect."
  : `Installed hooks for ${EVENTS.length} events -> ${URL}\nReload your VS Code windows (or start new Claude sessions) so they pick it up.`);

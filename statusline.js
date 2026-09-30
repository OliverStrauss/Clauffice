// Claude Code status line that also forwards your plan limits to Agent Office.
// Add to ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "node /full/path/to/statusline.js" }

const PORT = Number(process.env.PORT) || 4242;

let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", async () => {
  let data = {};
  try { data = JSON.parse(input); } catch { /* print a blank line below */ }

  // Office may be closed; never let that break the status line.
  await fetch(`http://127.0.0.1:${PORT}/usage`, { method: "POST", body: input, signal: AbortSignal.timeout(1000) }).catch(() => {});

  const left = (w) => (w && w.used_percentage != null ? `${Math.round(100 - w.used_percentage)}%` : "?");
  const r = data.rate_limits;
  console.log(r ? `5h: ${left(r.five_hour)} left · week: ${left(r.seven_day)} left` : (data.model?.display_name || ""));
});

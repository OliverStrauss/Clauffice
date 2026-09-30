# Agent Office

A pixel-art office that shows what your Claude Code sessions are doing. Each session is a worker at a desk, subagents show up as interns with laptops, and anyone who needs you gets a bouncing yellow "!".

It only watches for now. You still answer questions and approve permissions in VS Code.

## Run it

Needs Node 18 or newer. No packages to install.

```
node server.js
```

Open http://127.0.0.1:4242 and click **Run demo** to see it working before you connect anything. The same button turns into **Clear demo** to send the demo workers home.

## Connect your Claude sessions

```
node install-hooks.js
```

This adds HTTP hooks to `~/.claude/settings.json` (a backup is saved next to it first) so every Claude session reports to the office. Then reload your VS Code windows, or open new Claude tabs, so they pick up the hooks.

To undo: `node install-hooks.js --remove`

## Show your plan limits

The top bar can show how much of your 5-hour and weekly limits is left. Claude Code passes these numbers only to a status line command, so add this to `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node /full/path/to/statusline.js" }
```

The numbers update whenever Claude Code redraws its status line. They appear only for Pro and Max plans, and only from sessions that run a status line (the terminal CLI; the VS Code panel may not).

## First thing to do: the hook check

The VS Code extension doesn't fire every hook the terminal CLI does. After connecting, do a normal task in VS Code, then click **Hook check**. Any event still at zero isn't reaching the office from your setup. Every event is also saved to `logs/events.jsonl` so you can see the real payloads. The log starts fresh each time the server starts, and the previous run is kept as `logs/events.old.jsonl`.

## How the office reads events

| Hook event | In the office |
|---|---|
| SessionStart | Worker walks in and takes a desk in that project's room |
| UserPromptSubmit | Sits down to work; your prompt shows in the activity feed |
| PreToolUse | Animation depends on the tool: typing, reading paper, glowing monitor for terminal and web |
| PostToolUseFailure | Puff of smoke |
| PermissionRequest | "!" with what it wants to run |
| Stop | Nameplate turns green: "Finished work, waiting for more" (coffee on desk), or "!" if its last line is a question |
| SubagentStart / SubagentStop | Intern walks over with a laptop, then leaves |
| PreCompact | Yawns |
| InstructionsLoaded | Listed under Rulebook as loaded into that session |
| SessionEnd | Walks out the door |

Workers with no activity for 10 minutes doze off (finished workers stay green instead), and after an hour they go home.

## Share a public view

```
PUBLIC_PORT=4243 node server.js
cloudflared tunnel --url http://127.0.0.1:4243
```

Port 4243 is a separate, read-only office. It shows workers, rooms named after project folders, and what kind of thing each worker is doing (reading, writing, running a command). It never shows prompts, replies, commands, file names, paths, your machine name or the Rulebook, and it has no buttons. Share the tunnel URL, never port 4242.

## Files

- `server.js` receives hook events, tracks state, streams it to the page, and reads CLAUDE.md files for the Rulebook tab
- `public/index.html` is the office itself (canvas drawing plus the side panel)
- `install-hooks.js` adds or removes the hooks

## Safety

The server only listens on 127.0.0.1. Keep it that way until you add authentication, because the event stream contains your prompts, commands, and file paths.

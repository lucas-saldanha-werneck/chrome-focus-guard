# Changelog

## 0.3.1
- Any browser opened in the front is denied: `open -a/-na <browser>` without `-g` (seen 27/11 with a second Chrome Beta profile), or a browser binary run directly without `--headless`. Fix shown: `open -g -na ... --args`. Unlock with the `libera-foco-*` file.
- `bin/chrome-normal-scan` is now a bash shim for `lib/scan.mjs`: node refused the extensionless ES module when run from the plugin cache.
- The scan uses ripgrep with 2 threads when present (grep timed out on a loaded machine), timeout 240 s.

## 0.3.0
- Main Chrome rules moved to `lib/detect.mjs`, shared with the new `bin/chrome-normal-scan`.
- Bash: read-only `osascript` on the main Chrome is denied while it is closed (it would launch and restore all tabs); `webbrowser.open` / `python -m webbrowser`; launching it with port 9222; `BU_CDP_URL=...:9222`; scripts the command runs are checked.
- Write/Edit/MultiEdit of scripts: Playwright `channel: 'chrome'`, `Google Chrome.app` paths, `open -a "Google Chrome"` and `open <url>` inside exec/subprocess, AppleScript/JXA `activate`, `webbrowser.open(`, port 9222, the main profile's `DevToolsActivePort`. Comments and docs are ignored.
- Exceptions file `~/.config/chrome-focus-guard/allow.txt`.
- Main Chrome approval: only the user's own AskUserQuestion answer in the transcript (last 10 min, names "Chrome normal" and what was tried, answer "Sim"), one run per answer. The `libera-foco-*` file no longer unlocks the main Chrome (it still does for the automation Chrome focus rules).
- Writes to session transcripts and to the guard's state are denied.
- The denial lists what to try first: Beta in the background, other tools, then ask.
- `bin/chrome-normal-scan`: finds the same patterns in scripts run outside Claude (folders + loaded LaunchAgents), `--notify` for new findings.

## 0.2.0
- Also guards the main Chrome (not Beta) in Bash commands: `open -a "Google Chrome"`, `open <url>` with no app (the default browser is the main Chrome), `tell application "Google Chrome" ... activate`, `Application('Google Chrome').activate()` and browser-harness `activate_tab(`. Same one-use approval file.

## 0.1.0
- First version: PreToolUse guard for Bash, Write and Edit; one-use approval file.

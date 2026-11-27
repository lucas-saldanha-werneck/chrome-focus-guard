# chrome-focus-guard

A Claude Code hook that stops Claude from opening your main Chrome and from running scripts that steal focus from your automation Chrome.

A script that connects to the automation Chrome (CDP port 9223, `connectOverCDP`, `chrome-real`) and calls
`newPage(`, `bringToFront`, `.keyboard.`, `pressSequentially`, `/json/activate` or `activateTarget` brings Chrome
to the front while you are typing somewhere else. The hook denies the command before it runs and shows the
right recipe: a background tab with `Target.createTarget {background:true}`, text set by JS, keys sent with
`Input.dispatchKeyEvent` on the tab's own CDP session.

It reads the script file named in the command, not only the command text. Comments are ignored.
Scripts under a `web-unlock/` folder (`cdp.mjs`, `chrome-real.sh`) and this repo are never blocked.
It only sees what Claude runs; for scheduled jobs see `bin/chrome-normal-scan` below.

## The main Chrome

Anything that opens the main Chrome (not Beta), drives it, or brings it to the front is denied.

**Bash:** `open -a "Google Chrome"` (with or without `-g`), `open <url>` with no app (it goes to the default
browser, here the main Chrome), `tell application "Google Chrome" ... activate`, `Application('Google Chrome').activate()`,
browser-harness `activate_tab(` / `activate=True`, `python -c "...webbrowser.open..."` / `python -m webbrowser`,
launching the main Chrome with `--remote-debugging-port=9222`, `BU_CDP_URL=...:9222`. Read-only `osascript` on the
main Chrome is allowed only while it is running: when it is closed, any `tell application "Google Chrome"` launches it
(and it restores all its tabs). A script the command runs (`node x.mjs`, `python3 x.py`, `bash x.sh`, `./x`) is read
with the rules below.

**Write/Edit/MultiEdit of a script** (`.mjs .cjs .js .ts .py .sh .zsh .bash .applescript`, or no extension with a
shebang): Playwright/puppeteer `channel: 'chrome'`, a path to `Google Chrome.app`, `open -a "Google Chrome"`
and `open <url>` inside exec/subprocess, AppleScript/JXA on Google Chrome with `activate`, `webbrowser.open(`,
port 9222 (`--remote-debugging-port=9222`, `localhost:9222`), the main profile's `Google/Chrome/DevToolsActivePort`.
Comments are ignored; docs (`.md` and other non-code files) are never checked.

**opencli:** `opencli` drives the main Chrome through its Browser Bridge extension, without `open -a` or port 9222. Any subcommand is denied (Bash, scripts the command runs, Write/Edit of scripts) except `--help`/`--version` and the ones that never touch a browser (`list`, `doctor`, `profile`, `daemon`, `plugin`, `adapter`, `skills`, `completion`, `validate`, `external`). The same one-use approval and `allow.txt` apply. The scan below lists scripts that call it.

Allowed: `open -g -a "Google Chrome Beta"`, Chrome Beta paths, opening files, apps or settings panes.

**Exceptions:** `~/.config/chrome-focus-guard/allow.txt`, one path prefix per line (`~` ok, `#` comments).
Files under those paths are not blocked (hook) and are listed apart (scanner).

### Approving one run of the main Chrome

The denial tells Claude what to try first, in order: (1) the automation Chrome Beta in the background
(`open -g -a "Google Chrome Beta"`, web-unlock `chrome-real.sh` / `cdp.mjs`); (2) other tools (agent-browser,
Scrapling, web-unlock); (3) only if all failed, ask you with AskUserQuestion. A file Claude writes is not enough:
the hook reads the session transcript (`transcript_path` in the hook input) and needs **your answer** to an
AskUserQuestion from the last 10 minutes where

- the question names "Chrome normal" and has "tentei" with Beta, agent-browser, Scrapling and web-unlock
  (e.g. `Liberar o Chrome normal 1 vez para <x>? tentei: Beta 9223 (<erro>), agent-browser (<erro>), Scrapling (<erro>), web-unlock (<erro>)`);
- the answer starts with "Sim" (option `Sim, liberar Chrome normal 1 vez`).

Each answer unlocks one Bash run (Write/Edit of the script do not use it up). Used answers are kept in
`~/.claude/state/chrome-focus-guard-used.txt`. The hook denies writes to `~/.claude/projects/**/*.jsonl` and to
that file (redirects, `tee`, `sed -i`, `cp`/`mv`/`rm`, scripts that `writeFile`/`open(..., 'a')`), so an answer
cannot be faked. Limit: a write through a path held in a variable is not seen.

Robots (`claude -p`) have nobody to answer, so they can never unlock the main Chrome.

## Approving one run of the automation Chrome (focus)

For the Beta focus rules, after your yes Claude creates a one-use file:

```sh
echo "You approved: <what you said>" > ~/.claude/state/libera-foco-$(date +%H%M)
```

The file must be newer than 10 minutes and have a note inside. The next blocked Bash call uses it and deletes it.
(Write/Edit of the script keeps the file; the run consumes it.) It does not unlock the main Chrome.

## Any browser in the front (focus)

`open -a`/`-na` of a browser (Chrome Beta, Chromium, Safari, Firefox, Brave, Edge, Arc...) without `-g` brings its window
to the front, and so does running a browser binary (`.../Contents/MacOS/Google Chrome Beta`) directly without
`--headless`. Both are denied with the fix: `open -g -na "Google Chrome Beta" --args <flags>` (`-j` also hides it).
Extra Beta profiles are fine; only the focus matters. In `.sh` scripts the scanner flags the same lines.
The `libera-foco-*` file unlocks one run.

## Scripts outside Claude: `bin/chrome-normal-scan`

The hook only sees what Claude runs. `bin/chrome-normal-scan` looks for the same patterns in the folders listed in
`~/.config/chrome-focus-guard/roots.txt` (default `~/.local/share/*` and `~/.local/bin`; a trailing `/*` means each
subfolder) and in the commands and scripts of loaded LaunchAgents, and prints `file:line: reason`. It uses ripgrep (2 threads) or grep as a
prefilter with a timeout (`CHROME_SCAN_TIMEOUT_MS`, default 240 s) and skips `node_modules`, venvs, `.git` and caches.

```sh
chrome-normal-scan                    # print; exit 1 if something is outside the exceptions
chrome-normal-scan --record           # also remember the current findings
chrome-normal-scan --notify <cmd>     # run `<cmd> "<text>"` (one argument) for findings not seen before
```

Seen findings live in `~/.local/state/chrome-focus-guard/seen.txt`. Run it daily with launchd (`StartCalendarInterval`).

## Settings via env

`CHROME_FOCUS_PORT` (default 9223), `CHROME_FOCUS_NORMAL_PORT` (default 9222), `CHROME_FOCUS_TTL_MS`,
`CHROME_FOCUS_STATE_DIR`, `CHROME_FOCUS_ALLOW_FILE`, `CHROME_FOCUS_CHROME_RUNNING` (`1`/`0`, skips `pgrep`; for tests).

## Test

`node tests/run.mjs`

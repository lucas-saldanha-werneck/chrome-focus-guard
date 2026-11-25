# chrome-focus-guard

A Claude Code hook that stops Claude from running scripts that steal focus from your automation Chrome.

A script that connects to the automation Chrome (CDP port 9223, `connectOverCDP`, `chrome-real`) and calls
`newPage(`, `bringToFront`, `.keyboard.`, `pressSequentially`, `/json/activate` or `activateTarget` brings Chrome
to the front while you are typing somewhere else. The hook denies the command before it runs and shows the
right recipe: a background tab with `Target.createTarget {background:true}`, text set by JS, keys sent with
`Input.dispatchKeyEvent` on the tab's own CDP session.

It reads the script file named in the command, not only the command text. Comments are ignored.
Scripts under a `web-unlock/` folder (`cdp.mjs`, `chrome-real.sh`) and this repo are never blocked.
It only sees commands Claude runs; scheduled jobs are not affected.

## Approving one run

If there is really no other way, Claude asks you. Only after your yes does it create a one-use file:

```sh
echo "You approved: <what you said>" > ~/.claude/state/libera-foco-$(date +%H%M)
```

The file must be newer than 10 minutes and have a note inside. The next blocked Bash call uses it and deletes it.
(Write/Edit of the script keeps the file; the run consumes it.)

## Settings via env

`CHROME_FOCUS_PORT` (default 9223), `CHROME_FOCUS_TTL_MS`, `CHROME_FOCUS_STATE_DIR`.

## Test

`node tests/run.mjs`

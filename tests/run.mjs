#!/usr/bin/env node
// Runs hooks/guard.mjs against sample events. Run: node tests/run.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'hooks', 'guard.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
const state = path.join(tmp, 'state'); fs.mkdirSync(state);
const env = { PATH: process.env.PATH, HOME: tmp, CHROME_FOCUS_STATE_DIR: state };
let pass = 0, fail = 0;

const write = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
function run(tool, input) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: tmp }), env, encoding: 'utf8' });
  const deny = r.stdout.includes('"deny"');
  return { deny, ms: Date.now() - t0, out: r.stdout };
}
function check(label, res, wantDeny) {
  const ok = res.deny === wantDeny; ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${res.deny ? 'deny' : 'allow'} (${res.ms} ms)`);
}

const bad = write('bad.mjs', "import {chromium} from 'playwright-core';\nconst b = await chromium.connectOverCDP('http://127.0.0.1:9223');\nconst p = await b.contexts()[0].newPage();\nawait p.keyboard.press('Enter');");
const good = write('good.mjs', "// sem bringToFront, sem keyboard.press\nconst b = await chromium.connectOverCDP('http://127.0.0.1:9223');\nconst cdp = await b.newBrowserCDPSession();\nawait cdp.send('Target.createTarget',{url:'x',background:true});\nconst s = await ctx.newCDPSession(p); await s.send('Input.dispatchKeyEvent',{});");
fs.mkdirSync(path.join(tmp, 'web-unlock', 'bin'), { recursive: true });
const cdpmjs = write('web-unlock/bin/cdp.mjs', "const port='9223'; /* ctx.newPage() would bring Chrome to the front */ // bringToFront");
const noport = write('noport.mjs', "const p = await ctx.newPage(); await p.bringToFront();");

const r = (l, t, i, d) => check(l, run(t, i), d);
r('(a) script file with 9223 + newPage -> blocked', 'Bash', { command: `node ${bad}` }, true);
r('(a2) heredoc inline -> blocked', 'Bash', { command: `node - <<'EOF'\nawait chromium.connectOverCDP('http://127.0.0.1:9223'); page.bringToFront()\nEOF` }, true);
r('(a3) node -e inline -> blocked', 'Bash', { command: `node -e "chromium.connectOverCDP('http://localhost:9223').then(b=>b.contexts()[0].newPage())"` }, true);
r('(a4) python pressSequentially-style via /json/activate -> blocked', 'Bash', { command: `python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:9223/json/activate/ABC')"` }, true);
r('(a5) Write of such script -> blocked', 'Write', { file_path: path.join(tmp, 'novo.mjs'), content: "connectOverCDP('http://127.0.0.1:9223'); ctx.newPage()" }, true);
r('(b) background-tab example (comments name the banned calls) -> allowed', 'Bash', { command: `node ${good}` }, false);
r('(c) web-unlock cdp.mjs -> allowed', 'Bash', { command: `node ${cdpmjs} https://x.com --title` }, false);
r('(d1) node -e console.log(1) -> allowed', 'Bash', { command: 'node -e "console.log(1)"' }, false);
r('(d2) npm test -> allowed', 'Bash', { command: 'npm test' }, false);
r('(d3) newPage without any CDP/9223 -> allowed', 'Bash', { command: `node ${noport}` }, false);
r('(d4) grep for the words, no interpreter -> allowed', 'Bash', { command: 'grep -rn "bringToFront|9223" ~/.claude' }, false);

// (f) main Chrome (not Beta): opening it, a URL in the default browser, bringing it to the front
r('(f1) open -a "Google Chrome" <url> -> blocked', 'Bash', { command: 'open -a "Google Chrome" "http://copilot.local/setup"; sleep 2' }, true);
r('(f2) open -g -a "Google Chrome" <url> -> blocked', 'Bash', { command: 'cd /tmp && open -g -a "Google Chrome" "http://x"' }, true);
r('(f3) open "$URL" (default browser) -> blocked', 'Bash', { command: 'U=https://example.com; [ -n "$U" ] && open "https://example.com/login"' }, true);
r('(f4) osascript tell Google Chrome to activate -> blocked', 'Bash', { command: `osascript -e 'tell application "Google Chrome" to activate'` }, true);
r('(f5) bh activate_tab -> blocked', 'Bash', { command: "timeout 90 bh <<'PY'\nactivate_tab(current_tab())\nPY" }, true);
r('(g1) open -g -a "Google Chrome Beta" <url> -> allowed', 'Bash', { command: 'open -g -a "Google Chrome Beta" "http://127.0.0.1:4387/x"' }, false);
r('(g2) open a file / an app / a settings pane -> allowed', 'Bash', { command: 'open -a Finder ~/Downloads; open "x-apple.systempreferences:com.apple.Screen-Time"; open ~/x.pdf' }, false);
r('(g3) open -a Safari <url> -> allowed', 'Bash', { command: 'open -a Safari https://example.com' }, false);
r('(g4) read-only JXA on Google Chrome (no activate) -> allowed', 'Bash', { command: `osascript -e 'tell application "Google Chrome" to get URL of every tab of every window'` }, false);
r('(g5) grep for the words -> allowed', 'Bash', { command: 'grep -rn "open -a \\"Google Chrome\\" https://x" ~/.claude' }, false);
r('(g6) bh new_tab (background) -> allowed', 'Bash', { command: "bh <<'PY'\nnew_tab('https://x.com')\nPY" }, false);
fs.writeFileSync(path.join(state, 'libera-foco-0900'), 'Lucas autorizou: abre no Chrome normal');
r('(f6) open -a "Google Chrome" with approval file -> allowed once', 'Bash', { command: 'open -a "Google Chrome" https://x' }, false);
r('(f7) and blocked again', 'Bash', { command: 'open -a "Google Chrome" https://x' }, true);

// (e) approval file: one use, needs a note, expires
const lib = path.join(state, 'libera-foco-1200');
fs.writeFileSync(lib, ''); check('(e0) empty approval file -> still blocked', run('Bash', { command: `node ${bad}` }), true);
fs.writeFileSync(lib, 'Lucas autorizou: pode abrir na frente');
check('(e1) with approval file -> allowed once', run('Bash', { command: `node ${bad}` }), false);
console.log(`      approval file gone after use: ${!fs.existsSync(lib)}`); !fs.existsSync(lib) ? pass++ : fail++;
check('(e2) second run -> blocked again', run('Bash', { command: `node ${bad}` }), true);
fs.writeFileSync(lib, 'Lucas autorizou: velho'); const old = new Date(Date.now() - 11 * 60 * 1000); fs.utimesSync(lib, old, old);
check('(e3) approval older than 10 min -> blocked', run('Bash', { command: `node ${bad}` }), true);
const perf = run('Bash', { command: 'ls -la' }); console.log(`      speed on a common command: ${perf.ms} ms`);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

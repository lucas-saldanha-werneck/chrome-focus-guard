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
const env = { PATH: process.env.PATH, HOME: tmp, CHROME_FOCUS_STATE_DIR: state, CHROME_FOCUS_CHROME_RUNNING: '1' };
let pass = 0, fail = 0;

const write = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
let extra = {};
function run(tool, input) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: tmp, ...extra }), env, encoding: 'utf8' });
  const deny = r.stdout.includes('"deny"');
  let out = r.stdout; try { out = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch (_) {}
  return { deny, ms: Date.now() - t0, out };
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
r('(g3) open -g -a Safari <url> -> allowed', 'Bash', { command: 'open -g -a Safari https://example.com' }, false);
r('(g4) read-only JXA on Google Chrome (no activate) -> allowed', 'Bash', { command: `osascript -e 'tell application "Google Chrome" to get URL of every tab of every window'` }, false);
r('(g5) grep for the words -> allowed', 'Bash', { command: 'grep -rn "open -a \\"Google Chrome\\" https://x" ~/.claude' }, false);
r('(g6) bh new_tab (background) -> allowed', 'Bash', { command: "bh <<'PY'\nnew_tab('https://x.com')\nPY" }, false);
// Main Chrome approval = the user's AskUserQuestion answer in the transcript (not a file).
const OPEN = { command: 'open -a "Google Chrome" https://x' };
const Qok = 'Liberar o Chrome normal 1 vez para o Lever? tentei: Beta 9223 (login recusado), agent-browser (captcha), Scrapling (403), web-unlock (authwall)';
const answerLine = (q, a, ageMs, uuid) => JSON.stringify({ type: 'user', uuid, timestamp: new Date(Date.now() - ageMs).toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', content: `Your questions have been answered: "${q}"="${a}". You can now continue with these answers in mind.` }] },
  toolUseResult: { questions: [{ question: q }], answers: { [q]: a } } });
const tr = path.join(tmp, 'projects', 'sess.jsonl'); fs.mkdirSync(path.dirname(tr), { recursive: true });
const setTr = (...lines) => { fs.writeFileSync(tr, ['{"type":"user","message":{"content":"oi"}}', ...lines].join('\n') + '\n'); extra = { transcript_path: tr }; };
const why = (label, res, word) => { const ok = res.deny && res.out.includes(word); ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${res.deny ? 'deny' : 'allow'}, says "${word}": ${res.out.includes(word)}`); };
setTr();
why('(f6a) no answer in the transcript -> blocked', run('Bash', OPEN), 'nenhuma resposta');
fs.writeFileSync(path.join(state, 'libera-foco-0900'), 'Lucas autorizou: abre no Chrome normal\ntentei: tudo\n');
r('(f6b) a libera-foco file does NOT unlock the main Chrome', 'Bash', OPEN, true);
fs.unlinkSync(path.join(state, 'libera-foco-0900'));
setTr(answerLine(Qok, 'Sim, liberar Chrome normal 1 vez', 2 * 60 * 1000, 'u-ok-1'));
r('(f6) valid "Sim" answer 2 min ago -> allowed once', 'Bash', OPEN, false);
why('(f7) same answer again -> blocked (1 use)', run('Bash', OPEN), 'já liberou');
setTr(answerLine(Qok, 'Sim, liberar Chrome normal 1 vez', 11 * 60 * 1000, 'u-old'));
why('(f9) "Sim" answer 11 min ago -> blocked', run('Bash', OPEN), 'mais de 10 min');
setTr(answerLine(Qok, 'Não', 60 * 1000, 'u-no'));
why('(f10) answer "Não" -> blocked', run('Bash', OPEN), 'não é "Sim"');
setTr(answerLine('Liberar o Chrome normal 1 vez para o Lever?', 'Sim, liberar Chrome normal 1 vez', 60 * 1000, 'u-notried'));
why('(f11) question without "tentei:" and the tools -> blocked', run('Bash', OPEN), 'não diz o que foi tentado');
setTr(answerLine(Qok, 'Sim, liberar Chrome normal 1 vez', 60 * 1000, 'u-ok-2'));
r('(f12) new valid answer -> allowed once more', 'Bash', OPEN, false);
setTr(answerLine(Qok, 'Sim, liberar Chrome normal 1 vez', 60 * 1000, 'u-ok-3'));
r('(f13) Write of a script with a valid answer -> allowed (answer kept for the run)', 'Write', { file_path: path.join(tmp, 'p.mjs'), content: "chromium.launch({ channel: 'chrome' })" }, false);
r('(f14) then the run -> allowed', 'Bash', OPEN, false);
r('(f15) then blocked again', 'Bash', OPEN, true);
extra = {};
{ const res = run('Bash', OPEN);
  const order = ['Chrome Beta', 'agent-browser', 'AskUserQuestion', 'tentei:', 'Sim, liberar Chrome normal 1 vez'].map(w => res.out.slice(res.out.indexOf('Faça nesta ordem')).indexOf(w));
  const ok = order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])); ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  (f8) message order: Beta -> other tools -> ask Lucas -> "tentei:" -> "Sim" option`); }

// (t) faking an approval: writes to transcripts and to the guard's state are denied; reads pass
const T = '~/.claude/projects/-x/abc.jsonl';
r('(t1) echo >> transcript -> blocked', 'Bash', { command: `echo '{"type":"user"}' >> ${T}` }, true);
r('(t2) tee -a transcript -> blocked', 'Bash', { command: `printf x | tee -a "$HOME/.claude/projects/-x/abc.jsonl"` }, true);
r('(t3) sed -i transcript -> blocked', 'Bash', { command: `sed -i '' 's/Não/Sim/' ${T}` }, true);
r('(t4) python appends to transcript -> blocked', 'Bash', { command: `python3 -c "open('/Users/x/.claude/projects/-x/abc.jsonl','a').write('x')"` }, true);
r('(t5) rm the used-answers file -> blocked', 'Bash', { command: 'rm ~/.claude/state/chrome-focus-guard-used.txt' }, true);
r('(t6) Write to a transcript -> blocked', 'Write', { file_path: '/Users/x/.claude/projects/-x/abc.jsonl', content: '{}' }, true);
r('(t7) Edit the used-answers file -> blocked', 'Edit', { file_path: '/Users/x/.claude/state/chrome-focus-guard-used.txt', old_string: 'a', new_string: '' }, true);
r('(t8) reading a transcript (grep/tail/jq) -> allowed', 'Bash', { command: `grep -c answers ${T}; tail -5 ${T} | jq .type > /tmp/out.txt` }, false);
r('(t9) Beta approval file libera-foco -> allowed', 'Bash', { command: 'echo "Lucas autorizou: x" > ~/.claude/state/libera-foco-1200' }, false);

// (b) any browser in the front (focus), Beta and extra profiles included
const JBEI = `open -na "Google Chrome Beta" --args --user-data-dir="$HOME/.chrome-jbei-meta" --remote-debugging-port=9231 --no-first-run "https://www.facebook.com/login"`;
r('(b1) real case 27/11: open -na "Google Chrome Beta" --args ... (no -g) -> blocked', 'Bash', { command: JBEI }, true);
r('(b2) same with open -g -na -> allowed', 'Bash', { command: JBEI.replace('open -na', 'open -g -na') }, false);
r('(b3) open -gja (hidden) -> allowed', 'Bash', { command: 'open -gja "Google Chrome Beta" https://x' }, false);
r('(b4) open -a Safari <url> (no -g) -> blocked', 'Bash', { command: 'open -a Safari https://example.com' }, true);
r('(b5) open -a "Google Chrome Beta" with --args -g later (still no -g flag) -> blocked', 'Bash', { command: 'open -a "Google Chrome Beta" --args -g' }, true);
r('(b6) Beta binary run directly -> blocked', 'Bash', { command: '"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" --user-data-dir=/tmp/p --remote-debugging-port=9231 &' }, true);
r('(b7) Beta binary --headless -> allowed', 'Bash', { command: '"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" --headless=new --remote-debugging-port=9231 &' }, false);
r('(b8) ps/pgrep naming the binary -> allowed', 'Bash', { command: 'pgrep -f "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"; ps aux | grep "Contents/MacOS/Google Chrome Beta"' }, false);
r('(b9) open -a Finder / TextEdit -> allowed', 'Bash', { command: 'open -a TextEdit ~/x.txt' }, false);
fs.writeFileSync(path.join(state, 'libera-foco-1300'), 'Lucas autorizou: abre o Beta na frente');
r('(b10) with libera-foco approval -> allowed once', 'Bash', { command: JBEI }, false);
r('(b11) then blocked again', 'Bash', { command: JBEI }, true);

// (h) Bash: osascript on the main Chrome without activate launches it when closed; webbrowser; port 9222
env.CHROME_FOCUS_CHROME_RUNNING = '0';
r('(h1) read-only osascript, main Chrome CLOSED -> blocked', 'Bash', { command: `osascript -e 'tell application "Google Chrome" to get URL of every tab of every window'` }, true);
r('(h2) JXA Application("Google Chrome"), CLOSED -> blocked', 'Bash', { command: `osascript -l JavaScript -e 'Application("Google Chrome").windows.length'` }, true);
r('(h3) osascript on Chrome Beta, closed main Chrome -> allowed', 'Bash', { command: `osascript -e 'tell application "Google Chrome Beta" to get URL of every tab of every window'` }, false);
env.CHROME_FOCUS_CHROME_RUNNING = '1';
r('(h4) read-only osascript, main Chrome RUNNING -> allowed', 'Bash', { command: `osascript -e 'tell application "Google Chrome" to get URL of every tab of every window'` }, false);
r('(h5) python -c webbrowser.open -> blocked', 'Bash', { command: `python3 -c "import webbrowser; webbrowser.open('https://x.com')"` }, true);
r('(h6) python -m webbrowser -> blocked', 'Bash', { command: 'python3 -m webbrowser https://x.com' }, true);
r('(h7) launch main Chrome with --remote-debugging-port=9222 -> blocked', 'Bash', { command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 &' }, true);
r('(h8) BU_CDP_URL=...:9222 bh -> blocked', 'Bash', { command: "BU_CDP_URL=http://127.0.0.1:9222 bh <<'PY'\nnew_tab('https://x')\nPY" }, true);
r('(h9) curl the Beta 9223 /json -> allowed', 'Bash', { command: 'curl -s http://127.0.0.1:9223/json/version' }, false);
const opener = write('opener.py', "import webbrowser\n# webbrowser.open is banned here\nwebbrowser.open('https://x.com')\n");
const commented = write('commented.py', "# webbrowser.open('https://x.com')\nprint('hi')\n");
r('(h10) python3 script that calls webbrowser.open -> blocked', 'Bash', { command: `python3 ${opener}` }, true);
r('(h11) python3 script where it is only a comment -> allowed', 'Bash', { command: `python3 ${commented}` }, false);
r('(h12) cat/grep the bad script (not running it) -> allowed', 'Bash', { command: `cat ${opener}; grep -n webbrowser ${opener}` }, false);
const allowDir = path.join(tmp, 'lever-main'); fs.mkdirSync(allowDir);
const lever = write('lever-main/apply.mjs', "import {chromium} from 'playwright';\nconst b = await chromium.launchPersistentContext(d, { channel: 'chrome' });\n");
const allowFile = write('allow.txt', `# exceptions\n${allowDir}/\n`); env.CHROME_FOCUS_ALLOW_FILE = allowFile;
r('(h13) script in the allow list -> allowed', 'Bash', { command: `node ${lever}` }, false);
r('(h14) same code outside the allow list -> blocked', 'Bash', { command: `node ${write('apply2.mjs', fs.readFileSync(lever, 'utf8'))}` }, true);

// (w) Write/Edit of scripts that use the main Chrome; docs and comments pass
const W = (l, file, content, d) => r(l, 'Write', { file_path: path.join(tmp, file), content }, d);
W('(w1) Playwright channel: "chrome" -> blocked', 'a.mjs', "await chromium.launch({ channel: 'chrome' })", true);
W('(w2) channel: "chrome-beta" -> allowed', 'b.mjs', "await chromium.launch({ channel: 'chrome-beta' })", false);
W('(w3) executablePath to Google Chrome.app -> blocked', 'c.ts', "puppeteer.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'})", true);
W('(w4) executablePath to Google Chrome Beta.app -> allowed', 'd.ts', "puppeteer.launch({executablePath: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'})", false);
W('(w5) execSync open -a "Google Chrome" -> blocked', 'e.js', "execSync(`open -a \"Google Chrome\" ${url}`)", true);
W('(w6) subprocess ["open","-a","Google Chrome",url] -> blocked', 'f.py', "subprocess.run(['open', '-a', 'Google Chrome', url])", true);
W('(w7) subprocess ["open","-g","-a","Google Chrome Beta",url] -> allowed', 'g.py', "subprocess.run(['open', '-g', '-a', 'Google Chrome Beta', url])", false);
W('(w8) AppleScript tell Google Chrome + activate -> blocked', 'h.applescript', 'tell application "Google Chrome"\n  activate\n  open location "https://x"\nend tell', true);
W('(w9) JXA Application("Google Chrome").activate() -> blocked', 'i.js', "const c = Application('Google Chrome');\nc.activate();", true);
W('(w10) webbrowser.open in .py -> blocked', 'j.py', "import webbrowser\nwebbrowser.open(url)", true);
W('(w11) --remote-debugging-port=9222 in .sh -> blocked', 'k.sh', '#!/bin/bash\n"$CHROME" --remote-debugging-port=9222 --user-data-dir=/tmp/x &', true);
W('(w12) open "$URL" line in .sh -> blocked', 'l.sh', '#!/bin/bash\nopen "https://example.com/login"', true);
W('(w13) the same text in a .md doc -> allowed', 'notes.md', "Never use channel: 'chrome' or open -a \"Google Chrome\" or webbrowser.open(url).", false);
W('(w14) only in comments -> allowed', 'm.mjs', "// never: channel: 'chrome'\n/* open -a \"Google Chrome\" https://x */\nconsole.log(1)", false);
W('(w15) python comment -> allowed', 'n.py', "# webbrowser.open(url) is banned\nprint(1)", false);
W('(w16) no extension + shebang -> checked (blocked)', 'tool', '#!/usr/bin/env python3\nimport webbrowser\nwebbrowser.open(u)', true);
W('(w17) no extension, no shebang -> allowed', 'README', "webbrowser.open(u)", false);
W('(w18) web-unlock tool itself -> allowed', 'web-unlock/bin/x.mjs', "chromium.launch({ channel: 'chrome' })", false);
W('(w23) log line "open " + url (not run) -> allowed', 'q.js', "log('open ' + url + ' failed')", false);
W('(w24) execSync("open " + url) -> blocked', 'r.js', "execSync('open ' + url)", true);
W('(w25) reads the main Chrome DevToolsActivePort -> blocked', 's.mjs', "readFileSync(HOME + '/Library/Application Support/Google/Chrome/DevToolsActivePort')", true);
W('(w26) Chrome Beta DevToolsActivePort -> allowed', 't.mjs', "readFileSync(HOME + '/Library/Application Support/Google/Chrome Beta/DevToolsActivePort')", false);
W('(w27) .sh that opens the Beta in the front -> blocked', 'u.sh', '#!/bin/bash\nopen -na "Google Chrome Beta" --args --user-data-dir=/tmp/p', true);
W('(w28) .sh with open -g -na Beta -> allowed', 'v.sh', '#!/bin/bash\nopen -g -na "Google Chrome Beta" --args --user-data-dir=/tmp/p', false);
const ed = write('edit-me.sh', '#!/bin/zsh\necho hi\n');
r('(w19) Edit adding open -a "Google Chrome" to a no-shebang-ext script -> blocked', 'Edit', { file_path: ed, old_string: 'echo hi', new_string: 'open -a "Google Chrome" https://x' }, true);
r('(w20) MultiEdit adding webbrowser.open -> blocked', 'MultiEdit', { file_path: path.join(tmp, 'j.py'), edits: [{ old_string: 'a', new_string: 'webbrowser.open(u)' }] }, true);
W('(w21) Python channel="chrome" -> blocked', 'o.py', "browser = p.chromium.launch(channel=\"chrome\")", true);

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

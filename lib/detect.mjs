// Shared detection rules for the main Chrome (not Beta). Used by hooks/guard.mjs and bin/chrome-normal-scan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const NORMAL_PORT = process.env.CHROME_FOCUS_NORMAL_PORT || '9222';
const NP = NORMAL_PORT.replace(/\D/g, '') || '9222';

const CODE_EXT = /\.(mjs|cjs|js|ts|py|sh|zsh|bash|applescript|scpt)$/i;

export function langOf(file, firstLine = '') {
  const m = String(file).match(/\.([a-z]+)$/i);
  const ext = m ? m[1].toLowerCase() : '';
  if (['mjs', 'cjs', 'js', 'ts'].includes(ext)) return 'js';
  if (ext === 'py') return 'py';
  if (['sh', 'zsh', 'bash'].includes(ext)) return 'sh';
  if (['applescript', 'scpt'].includes(ext)) return 'as';
  if (!ext && firstLine.startsWith('#!')) {
    if (/node|deno|bun|tsx/.test(firstLine)) return 'js';
    if (/python/.test(firstLine)) return 'py';
    if (/osascript/.test(firstLine)) return 'as';
    return 'sh';
  }
  return null;
}

export function isCodeFile(file, firstLine = '') {
  return CODE_EXT.test(String(file)) || langOf(file, firstLine) !== null;
}

// Blanks out comments but keeps line numbers.
const blank = s => s.replace(/[^\n]/g, ' ');
export function stripCode(text, lang) {
  let t = String(text);
  if (lang === 'js') {
    t = t.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[\s;{}()])\/\/[^\n]*/g, (m, a) => a + blank(m.slice(a.length)));
  } else if (lang === 'py' || lang === 'sh') {
    t = t.replace(/^#![^\n]*/, blank).replace(/(^|[ \t;])#[^\n]*/gm, (m, a) => a + blank(m.slice(a.length)));
    if (lang === 'py') t = t.replace(/^[ \t]*("""|''')[\s\S]*?\1/gm, blank); // docstrings
  } else if (lang === 'as') {
    t = t.replace(/\(\*[\s\S]*?\*\)/g, blank).replace(/(^|\s)--[^\n]*/g, (m, a) => a + blank(m.slice(a.length)));
  }
  return t;
}

export function stripShell(t) {
  return String(t).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}()])\/\/[^\n]*/g, '$1').replace(/(^|\s)#[^\n]*/g, '$1');
}

const Q = `\\\\?["'\`]`;
const GC = `Google(?:\\\\ | )Chrome(?!\\s*Beta|\\\\ Beta)`; // "Google Chrome", not "Google Chrome Beta"
const TELL_GC = new RegExp(`tell application ${Q}Google Chrome${Q}`);
const JXA_GC = new RegExp(`Application\\(\\s*${Q}Google Chrome${Q}\\s*\\)`);
const OPEN_A_GC = new RegExp(`(?:^|\\s)-[a-zA-Z]*a\\s*\\\\?["']?(?:/Applications/)?${GC}(?:\\.app)?\\\\?["']?(?=[\\s"'\`),\\]]|$)`);
const LEAD = /^\s*(?:(?:then|do|else|nohup|exec|time|command|sudo)\s+)*/;

// One shell command (or one line of a shell script). Returns a reason or null.
function shellOpen(t) {
  for (const seg of t.split(/[;&|\n]+/)) {
    const s = seg.replace(LEAD, '');
    if (!/^(?:\/usr\/bin\/)?open\s/.test(s)) continue;
    if (/Chrome Beta/.test(s)) continue;
    if (OPEN_A_GC.test(s)) return 'open -a "Google Chrome" (o Chrome normal)';
    if (!/(?:^|\s)-[a-zA-Z]*[ab]\b/.test(s) && /["']?https?:\/\//.test(s)) return 'open <url> (abre no navegador padrão, que é o Chrome normal)';
  }
  return null;
}

// Any browser opened in the front (focus), Beta and extra profiles included: `open -a/-na <browser>` without -g,
// or the browser binary run directly without --headless (macOS brings its window to the front).
const BROWSER = String.raw`(?:Google Chrome(?: Beta| Canary| Dev)?|Chromium|Safari|Firefox|Brave Browser|Microsoft Edge|Arc|Vivaldi|Opera)`;
const OPEN_BROWSER = new RegExp(String.raw`(?:^|\s)-[a-zA-Z]*a\s*\\?["']?(?:/Applications/)?${BROWSER}(?:\.app)?\\?["']?(?=[\s"']|$)`);
const BIN_BROWSER = new RegExp(String.raw`^["']?[^"'\s]*?(?:\\ |[^"'\s]| (?=[^"']*["']))*?\.app/Contents/MacOS/${BROWSER}["']?(?:\s|$)`);
export function bashBrowserFront(cmd) {
  const t = stripShell(cmd);
  for (const seg of t.split(/[;&|\n]+/)) {
    const s = seg.replace(LEAD, '');
    if (/^(?:\/usr\/bin\/)?open\s/.test(s)) {
      const flags = (s.split(/\s--args\b/)[0].match(/(?:^|\s)-[a-zA-Z]+/g) || []).join('');
      if (OPEN_BROWSER.test(s) && !/g/.test(flags.replace(/-/g, ''))) {
        return 'open -a/-na de navegador sem -g (abre a janela na frente e rouba o foco). Use open -g -na "Google Chrome Beta" --args ... (com -j fica escondido)';
      }
    } else if (BIN_BROWSER.test(s) && !/--headless\b/.test(s)) {
      return 'binário do navegador rodado direto (no macOS a janela vem para a frente). Use open -g -na "Google Chrome Beta" --args <as mesmas flags>, ou --headless';
    }
  }
  return null;
}

const PORT_RE = new RegExp(`remote-debugging-port[= ]${NP}\\b|(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${NP}\\b`);

// Bash command. opts.chromeRunning: () => boolean (only called when needed).
export function bashNormalChrome(cmd, opts = {}) {
  const t = stripShell(cmd);
  const o = shellOpen(t);
  if (o) return o;
  if (TELL_GC.test(t) && /\bactivate\b/.test(t)) return 'tell application "Google Chrome" ... activate';
  if (/Application\(\s*\\?["']Google Chrome\\?["']\s*\)\.activate\(/.test(t)) return "Application('Google Chrome').activate()";
  if (/(?:^|[\s;&|(])bh\b/.test(t) && /\bactivate_tab\s*\(|\bactivate\s*=\s*True/.test(t)) return 'bh activate_tab (traz o Chrome normal para a frente)';
  if (/python[\d.]*\b[\s\S]*(?:-m\s+webbrowser\b|\bwebbrowser\.(?:open|open_new|open_new_tab|get)\b)/.test(t)) return 'webbrowser.open (abre no navegador padrão, que é o Chrome normal)';
  if (new RegExp(`remote-debugging-port[= ]${NP}\\b`).test(t) && new RegExp(GC).test(t)) return `Chrome normal com --remote-debugging-port=${NP}`;
  if (new RegExp(`BU_CDP_(?:URL|WS)=\\S*:${NP}\\b|:${NP}/json/(?:new|activate)`).test(t)) return `porta ${NP} (o Chrome normal)`;
  if ((TELL_GC.test(t) || JXA_GC.test(t)) && /\bosascript\b/.test(t)) {
    const running = opts.chromeRunning ? opts.chromeRunning() : true;
    if (!running) return 'osascript no Chrome normal, que está fechado: isso abre o Chrome e ele restaura dezenas de abas';
  }
  return null;
}

// Script/code text. Returns [{line, reason}] (1-based lines), comments ignored.
export function codeNormalChrome(text, file) {
  const raw = String(text);
  const lang = langOf(file, raw.slice(0, 200).split('\n')[0]);
  if (!lang) return [];
  const lines = stripCode(raw, lang).split('\n');
  const hits = [];
  const add = (i, reason) => { if (!hits.some(h => h.line === i + 1)) hits.push({ line: i + 1, reason }); };
  const near = (i, re) => lines.slice(i, i + 12).some(l => re.test(l));
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    if (/\bchannel\s*[:=]\s*["'`]chrome["'`]/.test(l)) return add(i, "Playwright channel 'chrome' (o Chrome normal)");
    if (/Google(?:\\ | )Chrome\.app/.test(l)) return add(i, 'caminho Google Chrome.app (o Chrome normal)');
    if (/\bopen\b/.test(l) && OPEN_A_GC.test(l)) return add(i, 'open -a "Google Chrome" (o Chrome normal)');
    if (/["']-a["']\s*,\s*["']Google Chrome["']/.test(l)) return add(i, 'open -a "Google Chrome" (o Chrome normal)');
    if (TELL_GC.test(l) && near(i, /\bactivate\b/)) return add(i, 'tell application "Google Chrome" ... activate');
    if (JXA_GC.test(l) && near(i, /\.activate\s*\(/)) return add(i, "Application('Google Chrome').activate()");
    if (/\bwebbrowser\.(?:open|open_new|open_new_tab|get)\s*\(|-m\s+webbrowser\b/.test(l)) return add(i, 'webbrowser.open (navegador padrão = Chrome normal)');
    if (PORT_RE.test(l)) return add(i, `porta ${NP} (o Chrome normal com depuração)`);
    if (lang === 'sh') { const o = shellOpen(l) || bashBrowserFront(l); if (o) return add(i, o); }
    if (/Google\/Chrome\/DevToolsActivePort/.test(l)) return add(i, 'DevToolsActivePort do Chrome normal (conecta no Chrome normal)');
    const execCall = /\b(?:exec\w*|spawn\w*|system|Popen|check_call|check_output|call|run|\$)\s*[(`]/.test(l);
    if (execCall && /["'`]open\s+(?:-g\s+)?(?:["']?https?:\/\/|\$\{|["'`]\s*\+)/.test(l)) return add(i, 'open <url> (navegador padrão = Chrome normal)');
    if (execCall && /\[\s*["']open["']\s*,\s*(?:f?["']https?:|[A-Za-z_.]*(?:url|link|href)\w*\s*[\],])/i.test(l)) return add(i, 'open <url> (navegador padrão = Chrome normal)');
  });
  return hits;
}

// Exceptions: one path prefix per line (~ allowed, # comments).
export function loadAllow(file) {
  const f = file || process.env.CHROME_FOCUS_ALLOW_FILE || path.join(os.homedir(), '.config', 'chrome-focus-guard', 'allow.txt');
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return []; }
  return txt.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
    .map(l => (l.startsWith('~/') ? path.join(os.homedir(), l.slice(2)) : l));
}
const slash = s => String(s).replace(/\\/g, '/');
export const isAllowed = (p, list) => { p = slash(p); return list.map(slash).some(a => p === a || p.startsWith(a.endsWith('/') ? a : a + '/')); };

export function chromeRunning() {
  const f = process.env.CHROME_FOCUS_CHROME_RUNNING;
  if (f === '1') return true;
  if (f === '0') return false;
  try { return spawnSync('pgrep', ['-x', 'Google Chrome'], { timeout: 1500 }).status === 0; } catch (_) { return false; }
}

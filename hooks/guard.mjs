#!/usr/bin/env node
// chrome-focus-guard: PreToolUse hook. Denies a script that talks to the automation Chrome
// (CDP port 9223 / connectOverCDP / chrome-real) AND uses a call that brings Chrome to the front.
// Approval: a one-use file ~/.claude/state/libera-foco-<anything>, newer than 10 min, with a short
// note inside (what Lucas said). Deleted on its first use by a Bash call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.CHROME_FOCUS_PORT || '9223';
const TTL_MS = Number(process.env.CHROME_FOCUS_TTL_MS || 10 * 60 * 1000);
const STATE = process.env.CHROME_FOCUS_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const PREFIX = 'libera-foco-';

const CDP = new RegExp(`${PORT}|connectOverCDP|chrome-real|remote-debugging-port`);
const STEAL = /\bnewPage\s*\(|bringToFront|\.keyboard\.|pressSequentially|json\/activate|activateTarget/;
const RUNNER = /(^|[;&|(\n]\s*|\b(?:xargs|env|exec|time|nohup)\s+)(?:[\w.\/-]*\/)?(node|nodejs|python3?|npx|tsx|ts-node|bun|deno)\b/;
const SCRIPT_EXT = /\.(mjs|cjs|js|ts|py)$/;
const ALLOW_PATH = /\/(web-unlock|chrome-focus-guard)\//; // our own tools and tests may name these calls

function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}()])\/\/[^\n]*/g, '$1').replace(/(^|\s)#[^\n]*/g, '$1');
}

function expand(p, cwd) {
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd || process.cwd(), p);
}

function referencedScripts(command, cwd) {
  const out = [];
  for (const tok of command.split(/[\s'"=<>|;&()]+/)) {
    if (!SCRIPT_EXT.test(tok)) continue;
    const p = expand(tok, cwd);
    try { const st = fs.statSync(p); if (st.isFile() && st.size < 2_000_000) out.push(p); } catch (_) {}
  }
  return out;
}

function findSteal(text) {
  const t = stripComments(text);
  if (!CDP.test(t)) return null;
  const m = t.match(STEAL);
  return m ? m[0].replace(/\s*\($/, '(') : null;
}

// The main Chrome (not Beta): Bash commands that open it, bring it to the front, or open a URL in the
// default browser (on this Mac the default browser is the main Chrome). Seen 27/11/2026: `open -a
// "Google Chrome" <url>`, `open "$URL"` and browser-harness `activate_tab(...)` stole the focus.
const LEAD = /^\s*(?:(?:then|do|else|nohup|exec|time|command)\s+)*/;
function findNormalChrome(cmd) {
  const t = stripComments(cmd);
  for (const seg of t.split(/[;&|\n]+/)) {
    const s = seg.replace(LEAD, '');
    if (!/^(?:\/usr\/bin\/)?open\s/.test(s)) continue;
    if (/Chrome Beta/.test(s)) continue;
    if (/(?:^|\s)-a\s*["']?(?:\/Applications\/)?Google Chrome(?:\.app)?["']?(?=\s|$)/.test(s)) return 'open -a "Google Chrome" (o Chrome normal)';
    if (!/(?:^|\s)-[a-zA-Z]*[ab]\b/.test(s) && /["']?https?:\/\//.test(s)) return 'open <url> (abre no navegador padrão, que é o Chrome normal)';
  }
  if (/tell application \\?["']Google Chrome\\?["']/.test(t) && /\bactivate\b/.test(t)) return 'tell application "Google Chrome" ... activate';
  if (/Application\(\s*\\?["']Google Chrome\\?["']\s*\)\.activate\(/.test(t)) return "Application('Google Chrome').activate()";
  if (/(?:^|[\s;&|(])bh\b/.test(t) && /\bactivate_tab\s*\(|\bactivate\s*=\s*True/.test(t)) return 'bh activate_tab (traz o Chrome normal para a frente)';
  return null;
}

function token() {
  let files = [];
  try { files = fs.readdirSync(STATE).filter(f => f.startsWith(PREFIX)); } catch (_) {}
  for (const f of files) {
    const p = path.join(STATE, f);
    try {
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > TTL_MS) { fs.unlinkSync(p); continue; } // expired: clean up
      if (st.size < 8) continue; // needs a note with what Lucas said
      return p;
    } catch (_) {}
  }
  return null;
}

function deny(found, where, normal) {
  const reason = normal ?
`Bloqueado (chrome-focus-guard): o comando usa ${found}. Regra do Lucas (24/11): robô e agente não abrem nem trazem para a frente o Chrome normal.
Jeito certo: Chrome Beta de automação em segundo plano: web-unlock bin/chrome-real.sh start "<url>" (aba de fundo, porta ${PORT}) ou open -g -a "Google Chrome Beta" "<url>".
Se precisar mesmo do Chrome normal: pergunte ao Lucas com AskUserQuestion. Só com o "sim" dele no chat, crie o arquivo de liberação (vale 10 min, 1 uso): mkdir -p ${STATE} && echo "Lucas autorizou: <o que ele disse>" > ${path.join(STATE, PREFIX)}$(date +%H%M)` :
`Bloqueado (chrome-focus-guard): ${where} fala com o Chrome de automação (porta ${PORT}) e usa ${found}, o que traz o Chrome para a frente e rouba o foco do Lucas.
Jeito certo: aba em segundo plano com Target.createTarget {background:true}, texto por JS no evaluate, tecla por Input.dispatchKeyEvent na sessão da aba (ctx.newCDPSession(page)). Exemplo que funciona: ~/.local/share/linkedin-msg/li-bg-exemplo.mjs. Para ler página: web-unlock bin/cdp.mjs.
Se não tiver jeito: pergunte ao Lucas com AskUserQuestion. Só com o "sim" dele no chat, crie o arquivo de liberação (vale 10 min, 1 uso): mkdir -p ${STATE} && echo "Lucas autorizou: <o que ele disse>" > ${path.join(STATE, PREFIX)}$(date +%H%M)`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(raw); } catch (_) { return; }
  const tool = ev.tool_name, inp = ev.tool_input || {}, cwd = ev.cwd;
  let found = null, where = '';
  if (tool === 'Bash') {
    const cmd = String(inp.command || '');
    const normal = findNormalChrome(cmd);
    if (normal) {
      const tk = token();
      if (tk) { try { fs.unlinkSync(tk); } catch (_) {} return; }
      return deny(normal, 'o comando', true);
    }
    if (!RUNNER.test(cmd)) return; // fast exit: nothing is being run by an interpreter
    found = findSteal(cmd); where = 'o comando';
    if (!found) {
      for (const p of referencedScripts(cmd, cwd)) {
        if (ALLOW_PATH.test(p)) continue;
        let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
        found = findSteal(txt); if (found) { where = `o script ${p}`; break; }
      }
    } else if (ALLOW_PATH.test(cmd)) found = null;
  } else if (tool === 'Write' || tool === 'Edit') {
    const file = String(inp.file_path || '');
    if (!SCRIPT_EXT.test(file) || ALLOW_PATH.test(file)) return;
    found = findSteal(String(inp.content ?? inp.new_string ?? '')); where = `o arquivo ${file}`;
  } else return;
  if (!found) return;
  const tk = token();
  if (tk) { if (tool === 'Bash') { try { fs.unlinkSync(tk); } catch (_) {} } return; } // Write/Edit: keep it for the run
  deny(found, where);
});

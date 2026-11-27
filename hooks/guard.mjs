#!/usr/bin/env node
// chrome-focus-guard: PreToolUse hook.
// 1. Main Chrome (not Beta): denies anything that opens it, drives it or brings it to the front. Approval only by
//    the user's own answer to an AskUserQuestion in the session transcript (last 10 min, question names
//    "Chrome normal" and what was tried, answer starts with "Sim"); each answer unlocks one run.
// 2. Automation Chrome (CDP port 9223): denies a script that brings it to the front. Approval: a one-use file
//    ~/.claude/state/libera-foco-<anything>, newer than 10 min, with a short note inside.
// 3. Denies writes to session transcripts and to this guard's state (so approvals cannot be faked).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashNormalChrome, codeNormalChrome, isCodeFile, loadAllow, isAllowed, chromeRunning } from '../lib/detect.mjs';

const PORT = process.env.CHROME_FOCUS_PORT || '9223';
const TTL_MS = Number(process.env.CHROME_FOCUS_TTL_MS || 10 * 60 * 1000);
const STATE = process.env.CHROME_FOCUS_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const PREFIX = 'libera-foco-';

const CDP = new RegExp(`${PORT}|connectOverCDP|chrome-real|remote-debugging-port`);
const STEAL = /\bnewPage\s*\(|bringToFront|\.keyboard\.|pressSequentially|json\/activate|activateTarget/;
const RUNNER = /(^|[;&|(\n]\s*|\b(?:xargs|env|exec|time|nohup)\s+)(?:[\w.\/-]*\/)?(node|nodejs|python3?|npx|tsx|ts-node|bun|deno)\b/;
const SCRIPT_EXT = /\.(mjs|cjs|js|ts|py)$/;
const ALLOW_PATH = /[\\/](web-unlock|chrome-focus-guard)[\\/]/; // our own tools and tests may name these calls

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


// Scripts the command RUNS (not just names): `node x.mjs`, `python3 x.py`, `bash x.sh`, `./x.sh`, `~/bin/x`.
const RUN_WORD = /^(?:[\w.\/-]*\/)?(node|nodejs|python[\d.]*|bash|sh|zsh|tsx|ts-node|bun|deno|osascript)$/;
const SKIP_WORD = /^(?:[A-Za-z_]\w*=\S*|env|nohup|exec|time|command|sudo|then|do|else|caffeinate|nice|op-env|--)$/;
function executedScripts(cmd, cwd) {
  const out = [];
  for (const seg of stripComments(cmd).split(/[;&|\n()]+/)) {
    const w = seg.trim().split(/\s+/).map(x => x.replace(/^["']|["']$/g, '')).filter(Boolean);
    let i = 0;
    while (i < w.length && (SKIP_WORD.test(w[i]) || (/^g?timeout$/.test(w[i]) && ++i))) i++;
    if (i >= w.length) continue;
    let cand = null;
    if (RUN_WORD.test(w[i])) { for (let j = i + 1; j < w.length; j++) { if (w[j] === '-c' || w[j] === '-e' || w[j] === '-m') break; if (!w[j].startsWith('-')) { cand = w[j]; break; } } }
    else if (w[i].includes('/')) cand = w[i];
    if (!cand) continue;
    const p = expand(cand, cwd);
    try { const st = fs.statSync(p); if (st.isFile() && st.size < 2_000_000) out.push(p); } catch (_) {}
  }
  return out;
}

function scriptNormalChrome(p, allow) {
  if (ALLOW_PATH.test(p) || isAllowed(p, allow)) return null;
  let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
  if (!isCodeFile(p, txt.slice(0, 200).split('\n')[0])) return null;
  const h = codeNormalChrome(txt, p)[0];
  return h ? `${h.reason}, no script ${p}:${h.line}` : null;
}

// Automation Chrome approval: one-use file with a note.
function token() {
  let files = [];
  try { files = fs.readdirSync(STATE).filter(f => f.startsWith(PREFIX)); } catch (_) {}
  for (const f of files) {
    const p = path.join(STATE, f);
    try {
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > TTL_MS) { fs.unlinkSync(p); continue; } // expired: clean up
      if (st.size < 8) continue; // needs a note with what was said
      return p;
    } catch (_) {}
  }
  return null;
}

// Main Chrome approval: the user's answer to AskUserQuestion, read from the transcript Claude Code writes.
const USED = path.join(STATE, 'chrome-focus-guard-used.txt');
const TOOLS = [/Beta/i, /agent-browser/i, /Scrapling/i, /web-unlock/i];
function readTail(file, bytes = 3_000_000) {
  try {
    const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes); const b = Buffer.alloc(size - start);
    fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd);
    return b.toString('utf8');
  } catch (_) { return ''; }
}
// Returns {uuid} of a valid unused answer, or {why} explaining what is missing.
function answerApproval(ev) {
  const files = [ev.transcript_path, ev.agent_transcript_path].filter(Boolean);
  let used = new Set();
  try { used = new Set(fs.readFileSync(USED, 'utf8').split('\n').filter(Boolean)); } catch (_) {}
  let why = 'nenhuma resposta do Lucas a uma AskUserQuestion sobre o Chrome normal nos últimos 10 min';
  for (const f of files) {
    const lines = readTail(f).split('\n').filter(l => l.includes('Chrome normal') && l.includes('"answers"'));
    for (const l of lines.reverse()) {
      let o; try { o = JSON.parse(l); } catch (_) { continue; }
      const ans = o && o.type === 'user' && o.toolUseResult && o.toolUseResult.answers;
      if (!ans || typeof ans !== 'object') continue;
      const age = Date.now() - Date.parse(o.timestamp || '');
      if (!(age >= -60_000 && age <= TTL_MS)) { why = 'a resposta do Lucas tem mais de 10 min: pergunte de novo'; continue; }
      for (const [q, a] of Object.entries(ans)) {
        if (!/Chrome normal/i.test(q)) continue;
        if (!/^\s*Sim\b/i.test(String(a))) { why = `o Lucas respondeu "${String(a).slice(0, 60)}" (não é "Sim")`; continue; }
        if (!/tentei/i.test(q) || !TOOLS.every(r => r.test(q))) { why = 'a pergunta não diz o que foi tentado ("tentei:" com Beta, agent-browser, Scrapling e web-unlock)'; continue; }
        const id = String(o.uuid || o.toolUseResult && JSON.stringify(ans)) + '|' + q.slice(0, 80);
        if (used.has(id)) { why = 'essa resposta do Lucas já liberou 1 uso: pergunte de novo'; continue; }
        return { id };
      }
    }
  }
  return { why };
}

const ASK = `Faça nesta ordem:
1. Chrome Beta de automação (porta ${PORT}) em segundo plano: open -g -a "Google Chrome Beta" "<url>", ou web-unlock bin/chrome-real.sh start "<url>" / bin/cdp.mjs.
2. Outras ferramentas: agent-browser, Scrapling, web-unlock.
3. Só se tudo falhou: pergunte ao Lucas com AskUserQuestion. A pergunta precisa citar "Chrome normal" e ter "tentei:" com o resultado de cada um, por exemplo:
   "Liberar o Chrome normal 1 vez para <o quê>? tentei: Beta 9223 (<erro>), agent-browser (<erro>), Scrapling (<erro>), web-unlock (<erro>)"
   Opções: "Sim, liberar Chrome normal 1 vez" e "Não". Se ele escolher "Sim...", rode o mesmo comando de novo em até 10 min (vale 1 uso).
Robô (claude -p) não tem como liberar: não há quem responda.`;

function deny(found, where, normal, note = '') {
  const reason = normal ?
`Bloqueado (chrome-focus-guard): ${found}. Regra do Lucas: robô e agente não abrem nem trazem para a frente o Chrome normal.${note ? `\nLiberação recusada: ${note}.` : ''}
${ASK}` :
`Bloqueado (chrome-focus-guard): ${where} fala com o Chrome de automação (porta ${PORT}) e usa ${found}, o que traz o Chrome para a frente e rouba o foco do Lucas.
Jeito certo: aba em segundo plano com Target.createTarget {background:true}, texto por JS no evaluate, tecla por Input.dispatchKeyEvent na sessão da aba (ctx.newCDPSession(page)). Exemplo que funciona: ~/.local/share/linkedin-msg/li-bg-exemplo.mjs. Para ler página: web-unlock bin/cdp.mjs.
Se não tiver jeito: pergunte ao Lucas com AskUserQuestion. Só com o "sim" dele no chat, crie o arquivo de liberação (vale 10 min, 1 uso): mkdir -p ${STATE} && echo "Lucas autorizou: <o que ele disse>" > ${path.join(STATE, PREFIX)}$(date +%H%M)`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

// Main Chrome found: pass once with a valid answer, else deny. Bash consumes the answer; Write/Edit keep it for the run.
function gateNormal(found, ev, consume) {
  const r = answerApproval(ev);
  if (r.id) {
    if (consume) { try { fs.mkdirSync(STATE, { recursive: true }); fs.appendFileSync(USED, r.id + '\n'); } catch (_) {} }
    return;
  }
  deny(found, '', true, r.why);
}

// Writes to transcripts or to this guard's state would fake an approval.
const PROTECT = /\.claude[\\/]projects[\\/][^\s"'`]*\.jsonl|\.claude[\\/]state[\\/](?:chrome-focus-guard[\w.-]*|libera-foco-[\w.-]*)/;
function tamper(tool, inp) {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    const f = String(inp.file_path || '');
    return PROTECT.test(f) && !/libera-foco-/.test(f) ? f : null; // the Beta approval file is written by Claude on purpose
  }
  if (tool !== 'Bash') return null;
  const c = String(inp.command || '');
  const T = `["']?[^\\s"'\`;|&]*(?:\\.claude/projects/[^\\s"'\`;|&]*\\.jsonl|\\.claude/state/chrome-focus-guard[\\w.-]*)`;
  const res = [
    new RegExp(`>>?\\|?\\s*${T}`),                                   // > or >> redirect
    new RegExp(`\\btee\\b[^|;&]*${T}`),                              // tee [-a]
    new RegExp(`\\b(?:sed|perl|ruby)\\b[^|;&]*\\s-[a-zA-Z]*i[^|;&]*${T}`), // in-place edit
    new RegExp(`\\b(?:cp|mv|ln|dd|truncate|rm|install|rsync)\\b[^|;&]*${T}\\s*(?:$|[;&|)])`), // as last argument
  ];
  if (res.some(r => r.test(c))) return 'transcript/estado do guard';
  if (/\.claude[\\/](?:projects[\\/][\s\S]*\.jsonl|state[\\/]chrome-focus-guard)/.test(c) &&
      /\b(?:writeFile|appendFile|createWriteStream|open\s*\([^)]*["'][wa+]|write_text|\.write\s*\()/.test(c)) return 'transcript/estado do guard';
  return null;
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(raw); } catch (_) { return; }
  const tool = ev.tool_name, inp = ev.tool_input || {}, cwd = ev.cwd;
  let found = null, where = '';
  const t = tamper(tool, inp);
  if (t) return process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Bloqueado (chrome-focus-guard): não escreva em ${t} (transcript da sessão ou estado do guard). Isso falsificaria a liberação do Chrome normal. Ler (cat, grep, tail, jq) pode.` } }));
  if (tool === 'Bash') {
    const cmd = String(inp.command || '');
    let normal = bashNormalChrome(cmd, { chromeRunning });
    if (!normal) {
      const allow = loadAllow();
      for (const p of executedScripts(cmd, cwd)) { normal = scriptNormalChrome(p, allow); if (normal) break; }
    }
    if (normal) return gateNormal(normal, ev, true);
    if (!RUNNER.test(cmd)) return; // fast exit: nothing is being run by an interpreter
    found = findSteal(cmd); where = 'o comando';
    if (!found) {
      for (const p of referencedScripts(cmd, cwd)) {
        if (ALLOW_PATH.test(p)) continue;
        let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
        found = findSteal(txt); if (found) { where = `o script ${p}`; break; }
      }
    } else if (ALLOW_PATH.test(cmd)) found = null;
  } else if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    const file = String(inp.file_path || '');
    if (ALLOW_PATH.test(file) || isAllowed(path.resolve(file), loadAllow())) return;
    const text = tool === 'MultiEdit' ? (inp.edits || []).map(e => e.new_string || '').join('\n') : String(inp.content ?? inp.new_string ?? '');
    let first = text.split('\n')[0];
    if (tool !== 'Write') { try { first = fs.readFileSync(file, 'utf8').slice(0, 200).split('\n')[0]; } catch (_) {} }
    if (isCodeFile(file, first)) {
      const lang = /\.[a-z]+$/i.test(file) ? text : (first.startsWith('#!') && !text.startsWith('#!') ? first + '\n' + text : text);
      const h = codeNormalChrome(lang, file)[0];
      if (h) return gateNormal(`${h.reason}, no arquivo ${file}`, ev, false); // Write/Edit: keep the approval for the run
    }
    if (!SCRIPT_EXT.test(file)) return;
    found = findSteal(text); where = `o arquivo ${file}`;
  } else return;
  if (!found) return;
  const tk = token();
  if (tk) { if (tool === 'Bash') { try { fs.unlinkSync(tk); } catch (_) {} } return; } // Write/Edit: keep it for the run
  deny(found, where);
});

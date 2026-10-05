#!/usr/bin/env node
/**
 * herdr-hub —— 把多台服务器上的 herdr agent 聚合给手机浏览器
 *
 * 设计要点
 *  1. 不做协议翻译：SSH 进去敲「那台机器自己的 herdr CLI」。
 *     各服务器 herdr 版本/协议不必一致（本机实测 proto 15/16/19 混跑），
 *     因为跨版本协商这件事根本不发生 —— 每台机器用本地 CLI 管本地 server。
 *  2. 零 npm 依赖，只用 Node 内置模块。
 *  3. 写操作白名单：只允许 send-text / send-keys，不接受任意远程命令。
 *  4. 服务器之间完全隔离：一台连不上不影响其他台，各自独立返回状态。
 *
 * 启动：node hub.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PARSERS, locateShell, listCodexCandidatesShell, pickCodexCandidate,
  candidatesShell, tailsShell, isSafeSessionPath,
} from './parsers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.HUB_CONFIG || path.join(ROOT, 'servers.json');
const TOKEN_FILE = path.join(ROOT, 'token.txt');

const PORT = Number(process.env.HUB_PORT || 8787);
const BIND = process.env.HUB_BIND || '0.0.0.0';
const SSH_BIN = process.env.HUB_SSH || 'ssh';
const SSH_OPTS = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
  '-o', 'ServerAliveInterval=15',
  '-o', 'LogLevel=ERROR',   // 压掉 RemoteForward 之类的 warning，别污染 stdout
];
const SSH_TIMEOUT_MS = Number(process.env.HUB_SSH_TIMEOUT || 25000);
const SNAPSHOT_CACHE_MS = 4000;
const ERROR_BACKOFF_MS = 15000;
const MAX_BUFFER = 8 * 1024 * 1024;

// 会话记录：一次最多从远端拉多少字节 / 多少行。codex 的 rollout 单个能到 20MB+，
// 所以必须 tail 而不是整读；解析不出来的首行（被截断）会被自动跳过。
const TAIL_BYTES = Number(process.env.HUB_TAIL_BYTES || 400000);
const TAIL_LINES = Number(process.env.HUB_TAIL_LINES || 600);
const MSG_BUDGET_BYTES = 260 * 1024;   // 发给手机的消息总预算
const TRANSCRIPT_TTL_MS = 15 * 60 * 1000;
const PREVIEW_TTL_MS = 90 * 1000;
const PREVIEW_PER_CYCLE = 3;

// ─────────────────────────── 语音识别（接口预留） ───────────────────────────
// 你在本机部署好语音模型后，把地址填进 hub.config.json 的 asr.url 即可，
// 代码不用改。兼容 whisper.cpp server（/inference）与 OpenAI 兼容的
// /v1/audio/transcriptions —— 两者都是 multipart 上传 + 返回 {text}。
const CONFIG_FILE = process.env.HUB_CONFIG_FILE || path.join(ROOT, 'hub.config.json');
let ASR = { url: '', token: '', language: 'zh', field: 'file', model: '', timeoutMs: 60000 };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.asr && typeof cfg.asr === 'object') ASR = { ...ASR, ...cfg.asr };
  }
} catch (err) {
  console.error(`[warn] 读 ${CONFIG_FILE} 失败，语音接口按未配置处理：${err.message}`);
}
const ASR_READY = !!ASR.url;

// ─────────────────────────────── 配置 ───────────────────────────────
let SERVERS = [];
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  SERVERS = (cfg.servers || []).filter((s) => s && s.id && s.host && s.bin);
} catch (err) {
  console.error(`[fatal] 读不到 ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}
if (!SERVERS.length) {
  console.error(`[fatal] ${CONFIG_PATH} 里没有任何服务器`);
  process.exit(1);
}
for (const s of SERVERS) {
  s.label = s.label || s.id;
  s._cache = null;      // { at, payload }
  s._backoffUntil = 0;
  s._error = null;
}

// ─────────────────────────────── 鉴权 ───────────────────────────────
let TOKEN = process.env.HUB_TOKEN;
if (TOKEN === undefined) {
  TOKEN = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}
const AUTH_DISABLED = TOKEN === 'off' || TOKEN === 'none';

function authorized(req, url) {
  if (AUTH_DISABLED) return true;
  const given =
    url.searchParams.get('t') ||
    req.headers['x-hub-token'] ||
    (req.headers.cookie || '').match(/(?:^|;\s*)hub_token=([^;]+)/)?.[1];
  if (!given || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────── SSH ───────────────────────────────
/** POSIX 单引号转义：' -> '\'' ，保证任意文本（含中文/引号/换行）安全传参 */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function shqArgv(argv) {
  return argv.map(shq).join(' ');
}

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: SSH_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8', ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

/** 在远程执行一条白名单命令（argv 形式，逐参数转义） */
async function remote(server, argv) {
  return execFileP(SSH_BIN, [...SSH_OPTS, server.host, shqArgv(argv)]);
}

/** 在远程执行「多条」命令（各自 argv 转义后用 && 连接），一次 SSH 往返 */
async function remoteChain(server, argvs) {
  const line = argvs.map(shqArgv).join(' && ');
  return execFileP(SSH_BIN, [...SSH_OPTS, server.host, line]);
}

/**
 * 执行一条「由本模块自己生成」的 shell 行。
 * ⚠️ 只允许传入 parsers.mjs 中 locateShell / listCodexCandidatesShell 的产物。
 * 任何来自用户或网络的数据都必须走 remote()/remoteChain() 的 argv 通道，
 * 那里的每一个参数都会被单引号转义。
 */
async function remoteShell(server, cmdline) {
  return execFileP(SSH_BIN, [...SSH_OPTS, server.host, cmdline]);
}

// ─────────────────────── 会话记录（③ 聊天式视图） ───────────────────────
const transcriptPaths = new Map(); // `${serverId}:${pane}` -> { at, ttl, result }
const previews = new Map();        // 同上 -> { text, at }

/**
 * 手动绑定：当 herdr 报不出会话路径、同目录又有多个 agent 时分不清，
 * 就让用户认领一次并记住。server:pane -> 绝对路径。
 */
const BINDINGS_FILE = path.join(ROOT, 'pane-bindings.json');
let bindings = {};
try {
  if (fs.existsSync(BINDINGS_FILE)) {
    const j = JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j)) if (isSafeSessionPath(v)) bindings[k] = v;
  }
} catch (err) {
  console.error(`[warn] 读 ${BINDINGS_FILE} 失败，手动绑定按空处理：${err.message}`);
}
function saveBindings() {
  try { fs.writeFileSync(BINDINGS_FILE, JSON.stringify(bindings, null, 2)); }
  catch (err) { console.error(`[warn] 写 ${BINDINGS_FILE} 失败：${err.message}`); }
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n…（已截断 ${t.length - n} 字）` : t;
}

/**
 * 找到这台机器上该 agent 的会话文件。
 *
 * 判定顺序：手动绑定 → 缓存 → herdr 明确告知 → 唯一候选 → 歧义（交给用户选）。
 * 关键原则：宁可说「分不清」，也绝不显示另一个 agent 的对话。
 * 没装集成（herdr 报不出会话路径）的机器，同目录多个 agent 时就是分不清。
 */
async function resolveTranscript(server, agent) {
  const key = `${server.id}:${agent.pane}`;
  const bound = bindings[key];
  if (bound) return { path: bound, diag: { how: 'binding' } };

  const hit = transcriptPaths.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;

  const diag = {
    agentKind: agent.agent, cwd: agent.cwd || null,
    agentSession: agent.agentSession || null,
    shell: null, stderr: null, exitCode: 0, how: null, attempts: 0,
  };
  let result;

  if (!agent.agent) {
    result = { path: null, diag: { ...diag, how: 'no-agent-kind' } };
  } else {
    try {
      // ① herdr 明确告知（pi 给路径 / codex 给 id）——最可靠，且天然区分同目录的多个 agent
      const shell = locateShell(agent.agent, agent.agentSession, agent.cwd);
      diag.shell = shell;
      let found = null;
      if (shell) {
        for (let attempt = 0; attempt < 2 && !found; attempt++) {
          const { stdout, stderr, err } = await remoteShell(server, shell);
          diag.stderr = String(stderr || '').slice(0, 300);
          diag.exitCode = (err && err.code) || 0;
          diag.attempts = attempt + 1;
          found = stdout.trim().split('\n').map((x) => x.trim()).filter(Boolean).pop() || null;
        }
      }
      if (found) {
        result = { path: found, diag: { ...diag, how: 'locate' } };
      } else if (agent.agent === 'codex') {
        // ② codex 没报 session id 时，按 cwd 在最近的 rollout 里找
        const { stdout } = await remoteShell(server, listCodexCandidatesShell(40));
        found = pickCodexCandidate(stdout, agent.cwd);
        result = found
          ? { path: found, diag: { ...diag, how: 'codex-cwd-match' } }
          : await ambiguous(server, agent, { ...diag, how: 'codex-cwd-miss' });
      } else {
        // ③ pi 但 herdr 报的路径已失效（实测见过 w4:p9 指向已删除的会话文件）或压根没报
        const cands = await listCandidates(server, agent);
        if (cands.length === 1) {
          result = { path: cands[0].path, diag: { ...diag, how: 'single-candidate' } };
        } else if (cands.length > 1) {
          result = { path: null, candidates: cands, diag: { ...diag, how: 'ambiguous', count: cands.length } };
        } else {
          result = { path: null, diag: { ...diag, how: 'no-candidate' } };
        }
      }
    } catch (err) {
      result = { path: null, diag: { ...diag, how: 'error', stderr: String(err && err.message).slice(0, 300) } };
    }
  }

  // 只有拿到确切结论才写缓存：SSH 抖动不该被当成「这台机器没有会话记录」记住一分钟
  const ttl = result.path ? TRANSCRIPT_TTL_MS : (result.diag.how === 'error' ? 0 : 60000);
  if (ttl > 0) transcriptPaths.set(key, { at: Date.now(), ttl, result });
  return result;
}

/** codex 按 cwd 没匹配上时，退回让用户从最近若干 rollout 里认领 */
async function ambiguous(server, agent, diag) {
  const cands = await listCandidates(server, agent);
  if (cands.length === 1) return { path: cands[0].path, diag: { ...diag, how: 'single-candidate' } };
  if (!cands.length) return { path: null, diag: { ...diag, how: 'no-candidate' } };
  return { path: null, candidates: cands, diag: { ...diag, how: 'ambiguous', count: cands.length } };
}

/** 列出候选会话文件，并给每个候选配一个「它最后说了什么」作为辨认依据 */
async function listCandidates(server, agent) {
  const shell = candidatesShell(agent.agent, agent.cwd, 12);
  if (!shell) return [];
  const { stdout } = await remoteShell(server, shell);
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const p = line.slice(0, i).trim();
    if (!isSafeSessionPath(p)) continue;
    rows.push({ path: p, mtime: (Number(line.slice(i + 1).trim()) || 0) * 1000 });
  }
  if (!rows.length) return [];

  // 一次 SSH 把各候选的尾部取回来，解析出最后一句作为标签
  const tails = tailsShell(rows.map((r) => r.path), 16000);
  if (tails) {
    const { stdout: out2 } = await remoteShell(server, tails);
    const byPath = new Map();
    for (const line of String(out2 || '').split('\n')) {
      const i = line.indexOf('\t');
      if (i < 0) continue;
      const p = line.slice(0, i).trim();
      const b64 = line.slice(i + 1).trim();
      if (!b64) continue;
      try { byPath.set(p, Buffer.from(b64, 'base64').toString('utf8')); } catch { /* 忽略坏的 */ }
    }
    for (const r of rows) {
      const text = byPath.get(r.path);
      if (!text) continue;
      const parsed = parseRecords(agent.agent, text);
      if (parsed) {
        r.label = clip((parsed.meta.lastAgentMessage || '').replace(/\s+/g, ' ').trim(), 120);
        r.messages = parsed.messages.length;
      }
    }
  }
  for (const r of rows) if (!r.label) r.label = r.path.split('/').pop();
  return rows;
}

/** 只把尾部拉回来（codex 的 rollout 能到 20MB+），被截断的首行会在解析时自然失败跳过 */
async function readTranscriptTail(server, agent, { bytes = TAIL_BYTES, lines = TAIL_LINES } = {}) {
  const res = await resolveTranscript(server, agent);
  if (!res.path) return { text: null, file: null, diag: res.diag, candidates: res.candidates };
  const { stdout } = await remoteShell(server, `tail -c ${bytes} ${shq(res.path)} | tail -n ${lines}`);
  if (!stdout.trim()) return { text: null, file: res.path, diag: res.diag };
  return { text: stdout, file: res.path, diag: res.diag };
}

function parseRecords(agentKind, text) {
  const parser = PARSERS[agentKind];
  if (!parser) return null;
  const records = [];
  let bad = 0;
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { records.push(JSON.parse(s)); } catch { bad++; }
  }
  if (!records.length) return null;
  return { ...parser(records), skipped: bad };
}

function clipMessage(m) {
  const out = { role: m.role, kind: m.kind, ts: m.ts || 0 };
  if (m.tool) out.tool = m.tool;
  if (m.isError) out.isError = true;
  if (m.pending) out.pending = true;
  if (m.phase) out.phase = m.phase;
  if (m.kind === 'text') out.text = clip(m.text, 12000);
  else if (m.kind === 'thinking') out.text = clip(m.text, 4000);
  else if (m.kind === 'call') { out.input = clip(m.input, 1500); out.output = clip(m.output, 2000); }
  else if (m.kind === 'result') out.output = clip(m.output, 2000);
  return out;
}

async function readConversation(server, agent, { limit = 60 } = {}) {
  if (!agent.agent || !PARSERS[agent.agent]) {
    return { ok: false, reason: 'unsupported', agent: agent.agent || null };
  }
  const tail = await readTranscriptTail(server, agent);
  if (!tail.text) {
    // 分不清是哪个会话 —— 把候选交出去让用户认领，而不是随便挑一个显示错内容
    if (tail.candidates && tail.candidates.length) {
      return {
        ok: false, reason: 'ambiguous', agent: agent.agent, diag: tail.diag,
        candidates: tail.candidates.map((c) => ({ path: c.path, label: c.label, mtime: c.mtime, messages: c.messages || 0 })),
      };
    }
    return { ok: false, reason: 'not-found', agent: agent.agent, diag: tail.diag };
  }
  const parsed = parseRecords(agent.agent, tail.text);
  if (!parsed) return { ok: false, reason: 'unparsable', agent: agent.agent, file: tail.file, diag: tail.diag };

  // 从最新往旧装，超预算就停 —— 手机上看到的永远是最近的一段
  const selected = [];
  let bytes = 0;
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const item = clipMessage(parsed.messages[i]);
    const size = (item.text?.length || 0) + (item.input?.length || 0) + (item.output?.length || 0) + 80;
    if (selected.length >= limit) break;
    if (selected.length && bytes + size > MSG_BUDGET_BYTES) break;
    bytes += size;
    selected.push(item);
  }
  selected.reverse();

  return {
    ok: true,
    agent: agent.agent,
    source: 'transcript',
    file: tail.file,
    meta: {
      sessionId: parsed.meta.sessionId,
      cwd: parsed.meta.cwd,
      model: parsed.meta.model,
      startedAt: parsed.meta.startedAt,
    },
    messages: selected,
    total: parsed.messages.length,
    shown: selected.length,
    more: parsed.messages.length > selected.length,
    skippedLines: parsed.skipped,
  };
}

/** 列表页预览：后台小步刷新，每轮只做几个，避免 SSH 风暴 */
let previewBusy = false;
async function refreshPreviews(rawServers, focusId) {
  if (previewBusy) return;
  previewBusy = true;
  try {
    const hot = [];
    const cold = [];
    for (const s of rawServers) {
      if (!s.ok) continue;
      const srv = findServer(s.id);
      if (!srv) continue;
      for (const a of s.agents) {
        if (!a.agent || !PARSERS[a.agent]) continue;
        const key = `${s.id}:${a.pane}`;
        const p = previews.get(key);
        if (p && Date.now() - p.at < PREVIEW_TTL_MS) continue;
        // 需要你 / 工作中的优先；空闲的排在后面，但也要填，否则列表页等于没有信息
        const item = { srv, agent: a, key, hot: ['blocked', 'done', 'working'].includes(a.status) };
        (item.hot ? hot : cold).push(item);
      }
    }
    // 手机当前正在看的那台服务器优先，别让它等
    const rank = (x) => (x.srv.id === focusId ? 0 : 1);
    hot.sort((a, b) => rank(a) - rank(b));
    cold.sort((a, b) => rank(a) - rank(b));
    const queue = [...hot, ...cold].slice(0, PREVIEW_PER_CYCLE);

    for (const job of queue) {
      let text = '';
      try {
        const tail = await readTranscriptTail(job.srv, job.agent, { bytes: 120000, lines: 200 });
        if (tail.text) {
          const parsed = parseRecords(job.agent.agent, tail.text);
          text = clip((parsed?.meta?.lastAgentMessage || '').replace(/\s+/g, ' ').trim(), 160);
        }
      } catch { /* 预览失败无所谓，列表照常显示 */ }
      previews.set(job.key, { text, at: Date.now() });
    }
  } finally {
    previewBusy = false;
  }
}

function publicServer(payload) {
  return {
    id: payload.id,
    label: payload.label,
    host: payload.host,
    ok: payload.ok,
    error: payload.error,
    agentCount: payload.agentCount,
    fetchedAt: payload.fetchedAt,
    agents: payload.agents.map((a) => {
      const { agentSession, ...rest } = a; // 会话文件绝对路径不下发到手机
      const pv = previews.get(`${payload.id}:${a.pane}`);
      return { ...rest, preview: pv && Date.now() - pv.at < PREVIEW_TTL_MS * 4 ? pv.text : null };
    }),
  };
}

/** 从 CLI 输出里抠 JSON（stdout 可能混有杂项，取第一个 { 到最后一个 }） */
function extractJson(stdout) {
  const i = stdout.indexOf('{');
  const j = stdout.lastIndexOf('}');
  if (i < 0 || j < 0 || j <= i) return null;
  try {
    return JSON.parse(stdout.slice(i, j + 1));
  } catch {
    return null;
  }
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n');
}

function shellQuoteTail(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * herdr 出错时会把 {"error":{"code","message"}} 信封写到 stderr（stdout 可能是空的），
 * 所以两边都要看。返回一句人话，别把整坨 JSON 丢给手机。
 */
function errorDetail(stdout, stderr, err) {
  for (const s of [stderr, stdout]) {
    const j = extractJson(s || '');
    if (!j) continue;
    const m = j.error?.message || (typeof j.error === 'string' ? j.error : '');
    if (m) return String(m).slice(0, 300);
  }
  const raw = String(stderr || stdout || (err && err.message) || '').trim();
  return raw.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) || '操作失败';
}

/** 判定一次写操作是否真的成功：优先看错误信封，其次看退出码 */
function writeFailed(stdout, stderr, err) {
  const j = extractJson(stdout || '') || extractJson(stderr || '');
  if (j && j.error) return true;
  if (!j && err && err.code) return true;
  if (err && err.killed) return true;
  return false;
}

// ─────────────────────── 状态历史（算「持续了多久」） ───────────────────────
const statusSince = new Map(); // key: serverId:pane -> { status, at }
function touchStatus(key, status) {
  const prev = statusSince.get(key);
  if (!prev || prev.status !== status) {
    const at = Date.now();
    statusSince.set(key, { status, at });
    // known=false 表示这是 hub 本次启动后第一次看到它，
    // 此时「持续了多久」无从得知，前端就不该显示一个假的“刚刚”。
    return { at, known: !!prev };
  }
  return { at: prev.at, known: true };
}

// ─────────────────────── 每台服务器：拉 agent 列表 ───────────────────────
function baseName(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function normalizeAgent(server, a) {
  const pane = a.pane_id || a.terminal_id || '';
  const status = a.agent_status || 'unknown';
  const rawTitle = a.terminal_title_stripped || a.terminal_title || '';
  const st = touchStatus(`${server.id}:${pane}`, status);
  return {
    serverId: server.id,
    serverLabel: server.label,
    pane,
    agent: a.agent || null,
    // herdr 会告诉我们这个 agent 的会话记录在哪（pi 给路径，codex 给 id）——
    // 这是「③ 读会话记录而非读屏幕」的入口，不下发到手机。
    agentSession: a.agent_session || null,
    status,
    cwd: a.cwd || '',
    repo: baseName(a.cwd) || '',
    title: rawTitle,
    focused: !!a.focused,
    workspace: a.workspace_id || '',
    tab: a.tab_id || '',
    path: pane, // 手机端显示用
    since: st.at,
    sinceKnown: st.known,
    now: Date.now(),
  };
}

async function fetchServer(server) {
  const now = Date.now();
  if (server._cache && now - server._cache.at < SNAPSHOT_CACHE_MS) return server._cache.payload;
  if (now < server._backoffUntil) return server._error || server._cache?.payload || offlinePayload(server, '连接冷却中');

  const { err, stdout, stderr } = await remote(server, [server.bin, 'agent', 'list']);
  const json = extractJson(stdout);

  if (!json?.result?.agents) {
    const detail = (stderr || stdout || (err && err.message) || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    server._error = offlinePayload(server, err?.killed ? 'SSH 超时' : detail || '无法读取 herdr agent 列表');
    server._backoffUntil = now + ERROR_BACKOFF_MS;
    return server._error;
  }

  const payload = {
    id: server.id,
    label: server.label,
    host: server.host,
    ok: true,
    error: null,
    agentCount: json.result.agents.length,
    agents: json.result.agents.map((a) => normalizeAgent(server, a)),
    fetchedAt: Date.now(),
  };
  server._cache = { at: now, payload };
  server._error = null;
  server._backoffUntil = 0;
  return payload;
}

function offlinePayload(server, message) {
  return {
    id: server.id,
    label: server.label,
    host: server.host,
    ok: false,
    error: message || '连接失败',
    agentCount: 0,
    agents: [],
    fetchedAt: Date.now(),
  };
}

// ─────────────────────────────── 图标 ───────────────────────────────
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 手搓一枚 App 图标：深色圆角底 + 三条「agent 卡片」+ 状态点。3x 超采样抗锯齿。 */
function buildIcon(size = 180) {
  const SS = 3;
  const W = size * SS;
  const buf = Buffer.alloc(W * W * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const sa = a / 255;
    buf[i] = Math.round(buf[i] * (1 - sa) + r * sa);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - sa) + g * sa);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - sa) + b * sa);
    buf[i + 3] = Math.max(buf[i + 3], Math.round(a));
  };
  const roundRect = (x0, y0, w, h, rad, paint) => {
    for (let y = Math.floor(y0); y < y0 + h; y++) {
      for (let x = Math.floor(x0); x < x0 + w; x++) {
        const dx = Math.max(x0 + rad - x, 0, x - (x0 + w - rad - 1));
        const dy = Math.max(y0 + rad - y, 0, y - (y0 + h - rad - 1));
        if (dx * dx + dy * dy <= rad * rad) paint(x, y);
      }
    }
  };

  // 底：竖向渐变（近黑 → 深蓝黑）
  roundRect(0, 0, W, W, W * 0.235, (x, y) => {
    const t = y / W;
    put(x, y, Math.round(10 + 6 * t), Math.round(14 + 14 * t), Math.round(22 + 30 * t), 255);
  });

  // 三条 agent 卡片 + 状态点
  const pad = W * 0.17;
  const cardH = W * 0.145;
  const gap = W * 0.075;
  const dots = [[52, 199, 123], [255, 176, 68], [96, 165, 250]]; // 待看 / 需授权 / 工作中
  for (let i = 0; i < 3; i++) {
    const y = pad + i * (cardH + gap);
    roundRect(pad, y, W - pad * 2, cardH, cardH * 0.34, (x, yy) =>
      put(x, yy, 255, 255, 255, 26));
    const r = cardH * 0.2;
    const cx = pad + cardH * 0.52;
    const cy = y + cardH / 2;
    for (let yy = Math.floor(cy - r); yy <= cy + r; yy++) {
      for (let xx = Math.floor(cx - r); xx <= cx + r; xx++) {
        const d = (xx - cx) ** 2 + (yy - cy) ** 2;
        if (d <= r * r) {
          const [rr, gg, bb] = dots[i];
          put(xx, yy, rr, gg, bb, 255);
        }
      }
    }
    // 两条「文本行」
    const tx = cx + cardH * 0.55;
    const tw = (W - pad * 2) - (tx - pad) - cardH * 0.42;
    roundRect(tx, cy - cardH * 0.22, tw, cardH * 0.14, cardH * 0.07, (x, yy) => put(x, yy, 235, 240, 248, 205));
    roundRect(tx, cy + cardH * 0.08, tw * 0.62, cardH * 0.12, cardH * 0.06, (x, yy) => put(x, yy, 235, 240, 248, 120));
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

let ICON_CACHE = null;
function iconPng() {
  if (!ICON_CACHE) ICON_CACHE = buildIcon(180);
  return ICON_CACHE;
}

// ─────────────────────────────── HTTP ───────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function findServer(id) {
  return SERVERS.find((s) => s.id === id);
}

/**
 * 读 pane 文本。两条路都要能走：
 *  - 新版 herdr 的 `--format text` 直接吐纯文本（不是 JSON 信封）
 *  - 老版本可能不认这个参数；也可能返回 {result:{text|lines|...}} 信封
 * 用 server._readFmt 记住这台机器适用哪条路，避免每次都白跑一次往返。
 */
function pickText(stdout, err) {
  if (err && (err.killed || err.code)) return null; // 命令本身失败 → 走回退
  const raw = stdout ?? '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const json = extractJson(raw);
    if (json && (json.result !== undefined || json.id !== undefined)) {
      return extractText(json); // 可能是 null（信封里没文本）→ 也走回退
    }
  }
  return raw; // 纯文本，空串也算合法结果（pane 就是空的）
}

async function readPane(server, pane, lines, source) {
  const src = ['visible', 'recent', 'recent-unwrapped'].includes(source) ? source : 'recent-unwrapped';
  const n = Math.max(20, Math.min(2000, Number(lines) || 300));
  const base = [server.bin, 'pane', 'read', pane, '--source', src, '--lines', String(n)];

  let text = null;
  let lastErr = null;

  if (server._readFmt !== false) {
    const r = await remote(server, [...base, '--format', 'text']);
    text = pickText(r.stdout, r.err);
    if (text !== null) {
      server._readFmt = true;
    } else if (r.err && r.err.code && /unexpected|unknown|invalid|--format|usage/i.test(r.stderr || '')) {
      server._readFmt = false; // 这台机器的 herdr 不认 --format，以后别再试
      lastErr = r;
    } else {
      lastErr = r;
    }
  }

  // 只要还没确认「--format text 在这台机器上可用」，就再试一次朴素形式兜底
  if (text === null && server._readFmt !== true) {
    const r = await remote(server, base);
    text = pickText(r.stdout, r.err);
    if (text !== null) text = stripAnsi(text); // 无 --format 时可能带 ANSI
    lastErr = r;
  }

  if (text === null) {
    const le = lastErr || {};
    const sshErr = le.err;
    return {
      ok: false,
      error: sshErr?.killed ? 'SSH 超时' : errorDetail(le.stdout, le.stderr, sshErr),
      text: '',
    };
  }

  const cleaned = text.replace(/\n{4,}/g, '\n\n\n').replace(/[ \t]+$/gm, '');
  const all = cleaned.split('\n');
  const kept = all.length > n ? all.slice(-n) : all;
  return { ok: true, error: null, text: kept.join('\n'), source: src, requested: n, lines: kept.length, truncated: all.length > n };
}

function extractText(json) {
  const r = json?.result ?? json;
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.text === 'string') return r.text;
  if (typeof r.content === 'string') return r.content;
  if (typeof r.output === 'string') return r.output;
  if (Array.isArray(r.lines)) return r.lines.map((l) => (typeof l === 'string' ? l : l?.text ?? '')).join('\n');
  if (Array.isArray(r.cells)) return r.cells.map((l) => (typeof l === 'string' ? l : l?.text ?? '')).join('\n');
  if (typeof r.data === 'string') return r.data;
  return null;
}

const ALLOWED_KEYS = new Set([
  'enter', 'esc', 'tab', 'shift+tab', 'up', 'down', 'left', 'right',
  'ctrl+c', 'ctrl+d', 'ctrl+l', 'ctrl+u', 'space', 'backspace',
  'y', 'n', '1', '2', '3', '4',
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!authorized(req, url)) {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const body = Buffer.from(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<body style="font:16px -apple-system,sans-serif;background:#0b0f14;color:#e8eef7;padding:40px">' +
        '<h2>缺少访问令牌</h2><p>请用带 <code>?t=令牌</code> 的完整网址打开（令牌见服务器上的 token.txt）。</p>',
        'utf8',
      );
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      res.end(body);
      return;
    }
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  try {
    // ── 聚合快照：每台服务器一条独立记录，互不影响
    if (url.pathname === '/api/snapshot') {
      const results = await Promise.all(SERVERS.map((s) => fetchServer(s).catch((e) => offlinePayload(s, e.message))));
      // 预览用「带 agentSession 的原始记录」，否则定位不到会话文件
      refreshPreviews(results, url.searchParams.get('focus')).catch(() => {});
      return sendJson(res, 200, { ok: true, now: Date.now(), servers: results.map(publicServer) });
    }

    // ── 某个 agent 的对话（读它自己的会话记录，不是读屏幕）
    if (url.pathname === '/api/conversation') {
      const s = findServer(url.searchParams.get('server'));
      const pane = url.searchParams.get('pane') || '';
      if (!s) return sendJson(res, 404, { ok: false, error: '未知服务器' });
      if (!/^[A-Za-z0-9:_-]{1,64}$/.test(pane)) return sendJson(res, 400, { ok: false, error: '非法 pane id' });

      const snap = await fetchServer(s);
      const agent = snap.agents.find((a) => a.pane === pane);
      if (!agent) return sendJson(res, 404, { ok: false, error: '这个 pane 上没有 agent' });

      const conv = await readConversation(s, agent, { limit: Number(url.searchParams.get('limit')) || 60 });
      const out = {
        server: s.id,
        pane,
        status: agent.status,
        repo: agent.repo,
        title: agent.title,
        ...conv,
      };
      // ?debug=1 时把「怎么找会话文件的」一并返回，便于排查某台机器读不出对话
      if (url.searchParams.get('debug')) out.diag = conv.diag;
      return sendJson(res, 200, out);
    }

    // ── 认领：把这个 pane 绑定到某个会话文件（只接受我们自己列过的安全路径）
    if (url.pathname === '/api/bind' && req.method === 'POST') {
      const body = await readBody(req);
      const s = findServer(body.server);
      const pane = String(body.pane || '');
      const target = String(body.path || '');
      if (!s) return sendJson(res, 404, { ok: false, error: '未知服务器' });
      if (!/^[A-Za-z0-9:_-]{1,64}$/.test(pane)) return sendJson(res, 400, { ok: false, error: '非法 pane id' });
      if (!isSafeSessionPath(target)) return sendJson(res, 400, { ok: false, error: '非法会话文件路径' });

      const key = `${s.id}:${pane}`;
      if (body.clear) {
        delete bindings[key];
        saveBindings();
        transcriptPaths.delete(key);
        return sendJson(res, 200, { ok: true, cleared: true });
      }
      // 绑定前先确认文件真的存在，避免记下一个错路径
      const { stdout, err } = await remoteShell(s, `test -f ${shq(target)} && printf 'yes'`);
      if (err && err.code) return sendJson(res, 200, { ok: false, error: '这个文件在这台机器上不存在' });
      bindings[key] = target;
      saveBindings();
      transcriptPaths.delete(key);
      return sendJson(res, 200, { ok: true, bound: stdout.trim() === 'yes', path: target });
    }

    // ── 前端启动时问一次：语音接口配好了没
    if (url.pathname === '/api/config') {
      return sendJson(res, 200, { ok: true, asr: { ready: ASR_READY, language: ASR.language } });
    }

    // ── 语音识别（接口已就位；等你把本地模型部署好，填 hub.config.json 的 asr.url 即可）
    if (url.pathname === '/api/transcribe' && req.method === 'POST') {
      if (!ASR_READY) {
        return sendJson(res, 200, {
          ok: false, configured: false,
          error: '语音服务未配置',
          hint: '在本机跑一个语音模型（whisper.cpp server / faster-whisper / OpenAI 兼容接口），然后把它填进 hub.config.json 的 asr.url，无需改代码。',
        });
      }
      // 浏览器直接 POST 原始音频字节，hub 负责转成 multipart 发给你的模型
      const chunks = [];
      let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          size += c.length;
          if (size > 32 * 1024 * 1024) { reject(new Error('音频过大')); req.destroy(); return; }
          chunks.push(c);
        });
        req.on('end', resolve);
        req.on('error', reject);
      });
      if (!chunks.length) return sendJson(res, 400, { ok: false, error: '没有收到音频' });

      const buf = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const ext = ct.includes('mp4') ? 'm4a' : ct.includes('wav') ? 'wav' : ct.includes('ogg') ? 'ogg' : 'webm';
      const form = new FormData();
      form.append(ASR.field || 'file', new Blob([buf], { type: ct }), `speech.${ext}`);
      if (ASR.language) form.append('language', ASR.language);
      if (ASR.model) form.append('model', ASR.model);

      try {
        const r = await fetch(ASR.url, {
          method: 'POST',
          headers: ASR.token ? { authorization: `Bearer ${ASR.token}` } : {},
          body: form,
          signal: AbortSignal.timeout(Number(ASR.timeoutMs) || 60000),
        });
        const raw = await r.text();
        let text = '';
        try {
          const j = JSON.parse(raw);
          text = j.text ?? j.result ?? j.transcription ?? j.data?.text ?? '';
        } catch {
          text = raw; // 有些实现直接吐纯文本
        }
        if (!r.ok) return sendJson(res, 200, { ok: false, error: `语音服务返回 ${r.status}：${String(raw).slice(0, 200)}` });
        return sendJson(res, 200, { ok: true, text: String(text || '').trim() });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: `连不上语音服务：${err.message}` });
      }
    }

    // ── 读取 pane 屏幕（对话视图的兜底 / 「原始屏幕」开关）
    if (url.pathname === '/api/screen' || url.pathname === '/api/read') {
      const s = findServer(url.searchParams.get('server'));
      const pane = url.searchParams.get('pane') || '';
      if (!s) return sendJson(res, 404, { ok: false, error: '未知服务器' });
      if (!/^[A-Za-z0-9:_-]{1,64}$/.test(pane)) return sendJson(res, 400, { ok: false, error: '非法 pane id' });
      const out = await readPane(s, pane, url.searchParams.get('lines'), url.searchParams.get('source'));
      return sendJson(res, 200, { server: s.id, pane, ...out });
    }

    // ── 发送文本（可选回车提交）
    if (url.pathname === '/api/send' && req.method === 'POST') {
      const body = await readBody(req);
      const s = findServer(body.server);
      const pane = String(body.pane || '');
      if (!s) return sendJson(res, 404, { ok: false, error: '未知服务器' });
      if (!/^[A-Za-z0-9:_-]{1,64}$/.test(pane)) return sendJson(res, 400, { ok: false, error: '非法 pane id' });

      let text = shellQuoteTail(String(body.text ?? ''));
      const hadNewlines = /\n/.test(text);
      // TUI 里裸换行会被当成「提交」，会把一段话拆成几次提交。合并成单行更可预期。
      if (hadNewlines) text = text.replace(/\s*\n\s*/g, ' ').trim();
      // 必须用 trim 判断：纯空白/全角空格不能算有内容，否则会给 agent 发一个空回车
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: '内容为空' });
      if (text.length > 8000) return sendJson(res, 400, { ok: false, error: '内容过长' });

      const chain = [[s.bin, 'pane', 'send-text', pane, text]];
      if (body.enter !== false) chain.push([s.bin, 'pane', 'send-keys', pane, 'enter']);

      // dry-run：只告诉你「将会执行什么」，一个字节都不会进到 agent 里。
      // 用来验证参数构造与转义，而不打扰任何正在工作的 agent。
      if (body.dry) {
        return sendJson(res, 200, {
          ok: true,
          dry: true,
          executed: false,
          collapsed: hadNewlines,
          remote: s.host,
          command: chain.map(shqArgv).join(' && '),
          note: '这是将要执行的命令，本次未执行任何操作。',
        });
      }

      const { err, stdout, stderr } = await remoteChain(s, chain);
      if (writeFailed(stdout, stderr, err)) {
        return sendJson(res, 200, { ok: false, error: errorDetail(stdout, stderr, err), collapsed: hadNewlines });
      }
      // 发送后立刻作废该服务器缓存，让列表/详情尽快反映新状态
      s._cache = null;
      return sendJson(res, 200, { ok: true, collapsed: hadNewlines });
    }

    // ── 按键（回车 / Esc / Ctrl-C / 方向键 …）
    if (url.pathname === '/api/key' && req.method === 'POST') {
      const body = await readBody(req);
      const s = findServer(body.server);
      const pane = String(body.pane || '');
      const key = String(body.key || '').toLowerCase();
      if (!s) return sendJson(res, 404, { ok: false, error: '未知服务器' });
      if (!/^[A-Za-z0-9:_-]{1,64}$/.test(pane)) return sendJson(res, 400, { ok: false, error: '非法 pane id' });
      if (!ALLOWED_KEYS.has(key)) return sendJson(res, 400, { ok: false, error: `不支持的按键: ${key}` });

      const { err, stdout, stderr } = await remote(s, [s.bin, 'pane', 'send-keys', pane, key]);
      s._cache = null;
      if (writeFailed(stdout, stderr, err)) {
        return sendJson(res, 200, { ok: false, error: errorDetail(stdout, stderr, err) });
      }
      return sendJson(res, 200, { ok: true, key });
    }

    if (url.pathname === '/api/ping') return sendJson(res, 200, { ok: true, servers: SERVERS.length });

    // ── 图标 / manifest
    if (url.pathname === '/icon.png' || url.pathname === '/apple-touch-icon.png') {
      const png = iconPng();
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=86400' });
      return res.end(png);
    }

    // ── 静态文件
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      return res.end(data);
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

// ─────────────────────────────── 启动 ───────────────────────────────
function tailscaleIp() {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      const ip = !err && stdout ? stdout.trim().split('\n')[0].trim() : '';
      resolve(/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
    });
  });
}

server.listen(PORT, BIND, async () => {
  const ip = await tailscaleIp();
  const q = AUTH_DISABLED ? '' : `?t=${TOKEN}`;
  console.log('');
  console.log('  herdr-hub 已启动');
  console.log(`  服务器        ${SERVERS.map((s) => `${s.id}(${s.label})`).join('  ')}`);
  console.log(`  本机访问      http://127.0.0.1:${PORT}/${q}`);
  if (ip) console.log(`  手机访问      http://${ip}:${PORT}/${q}   ← Tailscale 内网`);
  else console.log(`  手机访问      http://<本机Tailscale IP>:${PORT}/${q}`);
  if (AUTH_DISABLED) console.log('  鉴权          已关闭（HUB_TOKEN=off）');
  else console.log(`  鉴权          令牌已启用（存在 ${path.basename(TOKEN_FILE)}）`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}

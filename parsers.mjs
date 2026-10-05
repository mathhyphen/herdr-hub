/**
 * 会话记录解析层
 *
 * 屏幕上那坨 80 列文本，只是结构化会话记录的劣化渲染。
 * 这里把 pi / codex 各自的原生 JSONL 归一化成同一种「消息」模型，
 * 交给前端渲染成聊天气泡。
 *
 * 归一化后的消息模型：
 *   { role: 'user'|'assistant'|'tool', kind: 'text'|'thinking'|'call'|'result',
 *     text, tool, input, output, isError, ts, final }
 *
 * 纯函数，不碰网络、不碰文件系统。
 */

/** 把 content 数组/字符串收敛成一段文本 */
function collectText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (typeof b === 'string') { out.push(b); continue; }
    if (!b || typeof b !== 'object') continue;
    if (typeof b.text === 'string') out.push(b.text);
    else if (typeof b.content === 'string') out.push(b.content);
  }
  return out.join('\n');
}

/** 从工具参数里挑出最有信息量的那一行（优先命令行） */
export function toolInput(args) {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') {
    const s = args.trim();
    if (s.startsWith('{')) {
      try { return toolInput(JSON.parse(s)); } catch { /* 不是 JSON 就原样 */ }
    }
    return s;
  }
  if (typeof args === 'object') {
    for (const k of ['command', 'cmd', 'script', 'code', 'query', 'pattern', 'path', 'file_path', 'prompt']) {
      if (typeof args[k] === 'string' && args[k].trim()) return args[k];
    }
    try { return JSON.stringify(args); } catch { return String(args); }
  }
  return String(args);
}

function tsOf(v, fallbackNum) {
  if (typeof v === 'string') { const n = Date.parse(v); if (!Number.isNaN(n)) return n; }
  if (typeof fallbackNum === 'number' && fallbackNum > 1e11) return fallbackNum;
  return 0;
}

/**
 * 把 toolCall 和它的 toolResult 合成一条，前端就能渲染成一张可展开的卡片，
 * 而不是「调用」和「输出」两行各占一块。
 * 配不上对的输出单独保留——宁可编号乱，也不丢信息。
 */
export function pairToolCalls(messages) {
  const pending = new Map();
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool' && m.kind === 'call') {
      const item = { ...m, output: '', isError: false, pending: true };
      out.push(item);
      if (m.callId) pending.set(m.callId, item);
      continue;
    }
    if (m.role === 'tool' && m.kind === 'result') {
      const target = m.callId ? pending.get(m.callId) : null;
      if (target) {
        target.output = m.output || '';
        target.isError = !!m.isError;
        target.pending = false;
        if (!target.tool && m.tool) target.tool = m.tool;
        if (!target.ts && m.ts) target.ts = m.ts;
        pending.delete(m.callId);
        continue;
      }
      out.push(m);
      continue;
    }
    out.push(m);
  }
  return out;
}

// ─────────────────────────────── pi ───────────────────────────────
/**
 * pi 的会话文件：~/.pi/agent/sessions/<编码后的cwd>/<ISO时间>_<uuid>.jsonl
 * herdr 的 agent_session.kind = "path"，直接给出绝对路径。
 * 每行 type ∈ { session, model_change, thinking_level_change, message }
 * message.role ∈ { user, assistant, toolResult }
 */
export function parsePi(records) {
  const messages = [];
  const meta = { agent: 'pi', sessionId: null, cwd: null, model: null, startedAt: 0, lastAgentMessage: '' };

  for (const d of records) {
    if (!d || typeof d !== 'object') continue;
    const t = d.type;

    if (t === 'session') {
      meta.sessionId = d.id || meta.sessionId;
      meta.cwd = d.cwd || meta.cwd;
      meta.startedAt = tsOf(d.timestamp, 0);
      continue;
    }
    if (t === 'model_change') {
      meta.model = d.modelId || d.model || meta.model;
      continue;
    }
    if (t !== 'message') continue;

    const m = d.message;
    if (!m || typeof m !== 'object') continue;
    const ts = tsOf(d.timestamp, m.timestamp);

    if (m.role === 'user') {
      const text = collectText(m.content).trim();
      if (text) messages.push({ role: 'user', kind: 'text', text, ts });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text && b.text.trim()) {
          messages.push({ role: 'assistant', kind: 'text', text: b.text, ts });
        } else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
          messages.push({ role: 'assistant', kind: 'thinking', text: b.thinking, ts });
        } else if (b.type === 'toolCall') {
          messages.push({ role: 'tool', kind: 'call', tool: b.name || 'tool', input: toolInput(b.arguments), callId: b.id, ts });
        }
      }
      continue;
    }

    if (m.role === 'toolResult') {
      let output = collectText(m.content);
      if (!output && m.details) {
        try { output = JSON.stringify(m.details); } catch { output = ''; }
      }
      messages.push({
        role: 'tool', kind: 'result', tool: m.toolName || '', output,
        isError: !!m.isError, callId: m.toolCallId, ts,
      });
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].kind === 'text') { meta.lastAgentMessage = messages[i].text; break; }
  }
  return { messages: pairToolCalls(messages), meta };
}

// ─────────────────────────────── codex ───────────────────────────────
/**
 * codex 的 rollout：~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl
 * 顶层 type ∈ { session_meta, event_msg, response_item, world_state, turn_context, token_usage_record }
 *
 * 两处坑：
 *  1. response_item 里 role=user 的是「模型输入」，塞满了 <environment_context>、
 *     <skills_instructions> 之类的注入内容；真正的用户提问在
 *     event_msg/item_completed 的 item.type = "UserMessage" 里。所以用户消息只取后者。
 *  2. reasoning 的正文是 encrypted_content（不可读），只有 summary 有内容。
 */
export function parseCodex(records) {
  const messages = [];
  const meta = { agent: 'codex', sessionId: null, cwd: null, model: null, startedAt: 0, lastAgentMessage: '', cliVersion: null };

  for (const d of records) {
    if (!d || typeof d !== 'object') continue;
    const t = d.type;
    const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
    const ts = tsOf(d.timestamp, 0);

    if (t === 'session_meta') {
      meta.sessionId = p.session_id || p.id || meta.sessionId;
      meta.cwd = p.cwd || meta.cwd;
      meta.cliVersion = p.cli_version || meta.cliVersion;
      meta.startedAt = ts;
      continue;
    }
    if (t === 'turn_context') {
      meta.model = p.model || meta.model;
      continue;
    }

    if (t === 'event_msg') {
      if (p.type === 'item_completed') {
        const it = p.item || {};
        if (it.type === 'UserMessage') {
          const text = collectText(it.content).trim();
          if (text) messages.push({ role: 'user', kind: 'text', text, ts, real: true });
        }
        // AgentMessage 不在这里取：response_item 里已有 assistant 正文，避免重复渲染
      } else if (p.type === 'task_complete' && typeof p.last_agent_message === 'string') {
        meta.lastAgentMessage = p.last_agent_message; // 只做列表页预览，不当作消息
      }
      continue;
    }

    if (t !== 'response_item') continue;
    const pt = p.type;

    if (pt === 'message') {
      if (p.role !== 'assistant') continue; // developer / user(注入上下文) 一律丢
      const text = collectText(p.content);
      if (text.trim()) messages.push({ role: 'assistant', kind: 'text', text, ts, phase: p.phase });
    } else if (pt === 'reasoning') {
      const s = collectText(p.summary).trim();
      if (s) messages.push({ role: 'assistant', kind: 'thinking', text: s, ts });
    } else if (pt === 'custom_tool_call') {
      messages.push({ role: 'tool', kind: 'call', tool: p.name || 'tool', input: toolInput(p.input), callId: p.call_id, ts });
    } else if (pt === 'custom_tool_call_output') {
      messages.push({ role: 'tool', kind: 'result', output: collectText(p.output), callId: p.call_id, ts });
    } else if (pt === 'function_call') {
      messages.push({ role: 'tool', kind: 'call', tool: p.name || 'tool', input: toolInput(p.arguments), callId: p.call_id, ts });
    } else if (pt === 'function_call_output') {
      messages.push({ role: 'tool', kind: 'result', output: typeof p.output === 'string' ? p.output : collectText(p.output), callId: p.call_id, ts });
    }
  }

  // 兜底：极少数版本没有 item_completed 的 UserMessage，就从 response_item 里捡，
  // 但必须滤掉 <environment_context>/<skills_instructions> 这类注入内容。
  if (!messages.some((m) => m.role === 'user')) {
    for (const d of records) {
      if (!d || d.type !== 'response_item') continue;
      const p = d.payload || {};
      if (p.type !== 'message' || p.role !== 'user') continue;
      const text = collectText(p.content).trim();
      if (!text || text.startsWith('<')) continue;
      messages.push({ role: 'user', kind: 'text', text, ts: tsOf(d.timestamp, 0), reconstructed: true });
    }
    messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  if (!meta.lastAgentMessage) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].kind === 'text') { meta.lastAgentMessage = messages[i].text; break; }
    }
  }
  return { messages: pairToolCalls(messages), meta };
}

// ─────────────────────────── 定位会话文件 ───────────────────────────
/**
 * pi 把 cwd 编码成目录名。规则是从真实目录名反推的（去掉开头的斜杠，
 * 其余 / 换成 -，再整体包上 --）：
 *   /home/user/projects/demo → --home-user-projects-demo--
 *   /tmp                           → --tmp--
 *   /home/user/示例/模板            → --home-user-示例-模板--
 * 注意别写成「前导 -- 再替换斜杠」，那会多出一个横线变成 ---data-…，找不到目录。
 */
export function encodePiCwd(cwd) {
  const s = String(cwd).replace(/^[/\\]+/, '');
  return '--' + s.replace(/[/\\:]/g, '-') + '--';
}

/** POSIX 单引号转义。locateShell 的输出会被原样送进远端 shell，所以路径必须转义。 */
function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成「找到这台机器上该 agent 的会话文件」的 shell 片段（打印绝对路径，找不到就打印空）。
 * 返回 null 表示这个 agent 类型没有可靠的定位方式。
 *
 * 注意：只允许在这里拼接 shell。调用方不得把任何用户输入拼进 remoteShell。
 * $HOME 必须保持可展开，所以用 "…" 与 '…' 拼接的写法。
 */
export function locateShell(agentKind, agentSession, cwd) {
  if (agentKind === 'pi') {
    if (agentSession && agentSession.kind === 'path' && agentSession.value) {
      // 先验证文件存在：herdr 报的路径可能是失效的（实测见过 w4:p9 指向一个已不存在的文件）。
      // 不存在就输出空，交给 hub 走候选/消歧，而不是拿着错路径硬读。
      return `test -f ${sq(agentSession.value)} && printf '%s\\n' ${sq(agentSession.value)}`;
    }
    // ⚠️ 这里绝不能用「取该目录最新的会话文件」来兜底：
    // 同一个 cwd 下常常并行跑着好几个 agent，那样会把别的 agent 的对话显示成它的。
    // 宁可返回 null 让上层说「分不清，请你认领」。
    return null;
  }

  if (agentKind === 'codex') {
    if (agentSession && agentSession.kind === 'id' && agentSession.value) {
      return `ls -t "$HOME/.codex/sessions"/*/*/*/rollout-*${sq(agentSession.value)}*.jsonl 2>/dev/null | head -1`;
    }
    return null; // 没有 session id 时改走 listCodexCandidatesShell + 按 cwd 匹配
  }
  return null;
}

/** 不知道 session id 时，列出最近的 codex rollout 及其首行，交给 Node 侧按 cwd 匹配 */
export function listCodexCandidatesShell(limit = 40) {
  return `for f in $(ls -t "$HOME/.codex/sessions"/*/*/*/rollout-*.jsonl 2>/dev/null | head -${Number(limit) || 40}); do printf '%s\\t' "$f"; head -c 3000 "$f" | head -n 1; echo; done`;
}

/** 从 listCodexCandidatesShell 的输出里挑出 cwd 匹配的最新一个 */
export function pickCodexCandidate(text, cwd) {
  if (!cwd) return null;
  const want = String(cwd).replace(/\/+$/, '');
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const file = line.slice(0, i).trim();
    const json = line.slice(i + 1).trim();
    if (!file || !json) continue;
    try {
      const d = JSON.parse(json);
      const c = (d.payload && d.payload.cwd) || d.cwd;
      if (c && String(c).replace(/\/+$/, '') === want) return file;
    } catch { /* 首行可能被 head -c 截断，跳过 */ }
  }
  return null;
}

// ───────────────────────── 歧义候选（无法自动判定时） ─────────────────────────
/**
 * 会话文件路径来自远端列举，之后还要拼回 shell，所以必须严格校验：
 * 只允许安全字符且必须以 .jsonl 结尾。任何可疑路径直接丢弃。
 */
export function isSafeSessionPath(p) {
  const s = String(p || '');
  return s.length > 0 && s.length < 4096
    && /^[A-Za-z0-9._@+/=-]+$/.test(s)
    && s.endsWith('.jsonl')
    && (s.includes('/.pi/agent/sessions/') || s.includes('/.codex/sessions/'));
}

/** 列出候选会话文件：`路径<TAB>修改时间` 每行一个 */
export function candidatesShell(agentKind, cwd, limit = 12) {
  const n = Math.max(2, Math.min(30, Number(limit) || 12));
  const emit = `for f in $(ls -t DIR/*.jsonl 2>/dev/null | head -${n}); do printf '%s\\t' "$f"; stat -c %Y "$f" 2>/dev/null || echo 0; done`;
  if (agentKind === 'pi' && cwd) {
    return emit.replace('DIR', `"$HOME/.pi/agent/sessions/"${sq(encodePiCwd(cwd))}`);
  }
  if (agentKind === 'codex') {
    return emit.replace('DIR', '"$HOME/.codex/sessions"/*/*/*/rollout-*');
  }
  return null;
}

/** 一次性把若干候选的尾部拉回来（base64，避免 JSONL 换行破坏分隔） */
export function tailsShell(paths, bytes = 16000) {
  const safe = paths.filter(isSafeSessionPath);
  if (!safe.length) return null;
  return safe.map((p) => `printf '%s\\t' ${sq(p)}; tail -c ${bytes} ${sq(p)} | base64 -w0; echo`).join('; ');
}

export const PARSERS = { pi: parsePi, codex: parseCodex };

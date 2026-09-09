#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { homedir } from 'os';
import { program } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// ─── Data parsing ────────────────────────────────────────────────────────────

function parseSession(filePath) {
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return messages;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c.type === 'text').map(c => c.text || '').join('\n').trim();
}

function buildConversation(messages) {
  const promptGroups = new Map();

  for (const msg of messages) {
    if (msg.type === 'user' && msg.promptId) {
      const content = msg.message?.content;
      if (Array.isArray(content) && content.some(c => c.type === 'tool_result')) continue;
      if (typeof content !== 'string' && !Array.isArray(content)) continue;
      const text = extractTextFromContent(content);
      if (!text) continue;
      if (!promptGroups.has(msg.promptId)) {
        promptGroups.set(msg.promptId, {
          uuid: msg.uuid,
          userText: text,
          assistantTexts: [],
          timestamp: msg.timestamp,
        });
      }
    }
  }

  const uuidToPromptId = new Map();
  for (const msg of messages) {
    if (msg.type === 'user' && msg.promptId && msg.uuid) {
      uuidToPromptId.set(msg.uuid, msg.promptId);
    }
  }

  const uuidToMsg = new Map();
  for (const msg of messages) {
    if (msg.uuid) uuidToMsg.set(msg.uuid, msg);
  }

  function findPromptId(uuid) {
    const visited = new Set();
    let current = uuid;
    while (current && !visited.has(current)) {
      visited.add(current);
      if (uuidToPromptId.has(current)) return uuidToPromptId.get(current);
      const msg = uuidToMsg.get(current);
      if (!msg) break;
      current = msg.parentUuid;
    }
    return null;
  }

  for (const msg of messages) {
    if (msg.type === 'assistant' && !msg.isSidechain) {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      const text = extractTextFromContent(content);
      if (!text) continue;
      const promptId = findPromptId(msg.uuid);
      if (!promptId) continue;
      const group = promptGroups.get(promptId);
      if (group) group.assistantTexts.push(text);
    }
  }

  const rounds = [];
  for (const [, group] of promptGroups) {
    if (group.userText && group.assistantTexts.length > 0) {
      rounds.push({
        user: group.userText,
        assistant: group.assistantTexts.join('\n\n'),
        timestamp: group.timestamp,
      });
    }
  }
  return rounds;
}

function buildMeta(messages, rounds, sessionId, projectPath) {
  const userMsgs = messages.filter(m => {
    if (m.type !== 'user' || !m.promptId || !m.timestamp) return false;
    const content = m.message?.content;
    return !(Array.isArray(content) && content.some(c => c.type === 'tool_result'));
  });
  const assistantMsgs = messages.filter(m => m.type === 'assistant' && !m.isSidechain);
  const timestamps = userMsgs.map(m => m.timestamp).filter(Boolean).sort();
  const startTime = timestamps[0] || null;
  const endTime = timestamps[timestamps.length - 1] || null;

  const toolCounts = {};
  const modelCounts = {};
  const serviceTierCounts = {};
  const tokens = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
  };

  for (const msg of assistantMsgs) {
    const message = msg.message || {};
    if (message.model) modelCounts[message.model] = (modelCounts[message.model] || 0) + 1;
    if (message.usage?.service_tier) {
      const tier = message.usage.service_tier;
      serviceTierCounts[tier] = (serviceTierCounts[tier] || 0) + 1;
    }

    const usage = message.usage || {};
    tokens.input += usage.input_tokens || 0;
    tokens.output += usage.output_tokens || 0;
    tokens.cacheCreation += usage.cache_creation_input_tokens || 0;
    tokens.cacheRead += usage.cache_read_input_tokens || 0;
    tokens.webSearchRequests += usage.server_tool_use?.web_search_requests || 0;
    tokens.webFetchRequests += usage.server_tool_use?.web_fetch_requests || 0;

    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use' && c.name) {
        toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
      }
    }
  }

  let userChars = 0;
  let aiChars = 0;
  for (const r of rounds) {
    userChars += r.user.length;
    aiChars += r.assistant.length;
  }

  const range = (values) => values.length === 0
    ? { min: 0, max: 0, avg: 0 }
    : {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      };
  const userRoundChars = range(rounds.map(r => r.user.length));
  const aiRoundChars = range(rounds.map(r => r.assistant.length));
  const firstMsg = rounds[0]?.user || '';
  const summary = firstMsg.length > 100 ? firstMsg.slice(0, 100) + '...' : firstMsg;
  const version = messages.find(m => m.version)?.version || 'unknown';
  const cwd = messages.find(m => m.cwd)?.cwd || projectPath || 'unknown';

  return {
    sessionId, projectPath, cwd, version, startTime, endTime,
    rounds: rounds.length, userChars, aiChars, userRoundChars, aiRoundChars,
    userMessageCount: userMsgs.length, assistantMessageCount: assistantMsgs.length,
    toolCounts, modelCounts, serviceTierCounts, tokens, summary,
  };
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function toMarkdown(rounds, sessionId) {
  const title = rounds[0]?.user?.split('\n')[0]?.slice(0, 80) || sessionId;
  const lines = [`# ${title}\n`, `> Session: \`${sessionId}\`\n`];

  for (let i = 0; i < rounds.length; i++) {
    const { user, assistant } = rounds[i];
    lines.push(`## Round ${i + 1}\n`);
    lines.push(`**User:**\n`);
    lines.push(`${user}\n`);
    lines.push(`**Assistant:**\n`);
    lines.push('```md');
    lines.push(assistant);
    lines.push('```\n');
  }
  return lines.join('\n');
}

function toMetaMarkdown(meta) {
  const fmt = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : 'N/A';
  const n = (value) => value.toLocaleString();
  const duration = (meta.startTime && meta.endTime)
    ? (() => {
        const ms = new Date(meta.endTime) - new Date(meta.startTime);
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
      })()
    : 'N/A';
  const rows = (counts) => Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `| ${name} | ${n(count)} |`)
    .join('\n');
  const totalTokens = meta.tokens.input + meta.tokens.output;

  const lines = [
    `# Session Meta: ${meta.sessionId}\n`,
    `## 基本信息\n`,
    `| 字段 | 值 |`,
    `|------|-----|`,
    `| Session ID | \`${meta.sessionId}\` |`,
    `| 项目路径 | \`${meta.cwd}\` |`,
    `| Claude Code 版本 | ${meta.version} |`,
    `| 开始时间 | ${fmt(meta.startTime)} |`,
    `| 结束时间 | ${fmt(meta.endTime)} |`,
    `| 持续时长 | ${duration} |`,
    ``,
    `## 对话统计\n`,
    `| 指标 | 数值 |`,
    `|------|-----|`,
    `| 对话轮次 | ${n(meta.rounds)} |`,
    `| 用户消息数 | ${n(meta.userMessageCount)} |`,
    `| AI 消息数 | ${n(meta.assistantMessageCount)} |`,
    `| 用户输入字数 | ${n(meta.userChars)} |`,
    `| AI 回复字数 | ${n(meta.aiChars)} |`,
    `| 总字数 | ${n(meta.userChars + meta.aiChars)} |`,
    ``,
    `### 单轮长度分布\n`,
    `| 内容 | 最小值 | 平均值 | 最大值 |`,
    `|------|-------:|-------:|-------:|`,
    `| 用户输入（字） | ${n(meta.userRoundChars.min)} | ${n(meta.userRoundChars.avg)} | ${n(meta.userRoundChars.max)} |`,
    `| AI 回复（字） | ${n(meta.aiRoundChars.min)} | ${n(meta.aiRoundChars.avg)} | ${n(meta.aiRoundChars.max)} |`,
    ``,
    `## 模型与 Token 消耗\n`,
    `| 指标 | Token |`,
    `|------|------:|`,
    `| 输入 Token | ${n(meta.tokens.input)} |`,
    `| 输出 Token | ${n(meta.tokens.output)} |`,
    `| 合计 Token（不含缓存） | ${n(totalTokens)} |`,
    `| 缓存创建 Token | ${n(meta.tokens.cacheCreation)} |`,
    `| 缓存读取 Token | ${n(meta.tokens.cacheRead)} |`,
    `| 计入请求的总 Token | ${n(totalTokens + meta.tokens.cacheCreation + meta.tokens.cacheRead)} |`,
    ``,
  ];

  const modelRows = rows(meta.modelCounts);
  if (modelRows) {
    lines.push(`### 模型使用分布\n`);
    lines.push(`| 模型 | AI 消息数 |`);
    lines.push(`|------|----------:|`);
    lines.push(modelRows);
    lines.push('');
  }

  const tierRows = rows(meta.serviceTierCounts);
  if (tierRows) {
    lines.push(`### 服务层级分布\n`);
    lines.push(`| 服务层级 | AI 消息数 |`);
    lines.push(`|----------|----------:|`);
    lines.push(tierRows);
    lines.push('');
  }

  const toolRows = rows(meta.toolCounts);
  if (toolRows) {
    lines.push(`## 工具调用\n`);
    lines.push(`| 工具 | 调用次数 |`);
    lines.push(`|------|---------:|`);
    lines.push(toolRows);
    lines.push('');
  }

  if (meta.tokens.webSearchRequests || meta.tokens.webFetchRequests) {
    lines.push(`## 服务端 Web 工具\n`);
    lines.push(`| 工具 | 请求次数 |`);
    lines.push(`|------|---------:|`);
    lines.push(`| Web Search | ${n(meta.tokens.webSearchRequests)} |`);
    lines.push(`| Web Fetch | ${n(meta.tokens.webFetchRequests)} |`);
    lines.push('');
  }

  lines.push(`## 主题摘要\n`);
  lines.push(`> ${meta.summary}`);
  lines.push('');
  return lines.join('\n');
}

// ─── Project / session discovery ─────────────────────────────────────────────

function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR).filter(f => {
    try { return readdirSync(join(PROJECTS_DIR, f)).some(s => s.endsWith('.jsonl')); }
    catch { return false; }
  });
}

function listSessions(project) {
  const dir = join(PROJECTS_DIR, project);
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f.replace('.jsonl', ''), file: join(dir, f), project }));
}

// Cache of project dir name → real cwd path, loaded lazily
const _projectCwdCache = new Map();

function getProjectRealPath(projectDirName) {
  if (_projectCwdCache.has(projectDirName)) return _projectCwdCache.get(projectDirName);

  const dir = join(PROJECTS_DIR, projectDirName);
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const lines = readFileSync(join(dir, f), 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.cwd) {
            _projectCwdCache.set(projectDirName, d.cwd);
            return d.cwd;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  // Fallback: best-effort decode (single - = /, double -- = -)
  let p = projectDirName
    .replace(/--/g, '\x00')
    .replace(/-/g, '/')
    .replace(/\x00/g, '-');
  _projectCwdCache.set(projectDirName, p);
  return p;
}

function findSessionById(uuid) {
  const projects = listProjects();
  for (const project of projects) {
    const file = join(PROJECTS_DIR, project, `${uuid}.jsonl`);
    if (existsSync(file)) return { file, project, name: uuid };
  }
  return null;
}

// Find all sessions whose decoded project path starts with the given real path
function findSessionsByDir(realPath) {
  const normalized = realPath.replace(/\/$/, '');
  const projects = listProjects();
  const results = [];
  for (const project of projects) {
    const decoded = getProjectRealPath(project);
    if (decoded === normalized || decoded.startsWith(normalized + '/')) {
      for (const s of listSessions(project)) {
        results.push({ ...s, realPath: decoded });
      }
    }
  }
  return results;
}

// ─── Export helpers ───────────────────────────────────────────────────────────

function sessionsOutputDir(realProjectPath) {
  return join(realProjectPath, 'sessions');
}

function exportSession(sessionInfo) {
  const { file, name: sessionId, realPath } = sessionInfo;
  const messages = parseSession(file);
  const rounds = buildConversation(messages);

  if (rounds.length === 0) return { sessionId, skipped: true, reason: 'no conversation' };

  const outDir = sessionsOutputDir(realPath);
  mkdirSync(outDir, { recursive: true });

  const md = toMarkdown(rounds, sessionId);
  const meta = buildMeta(messages, rounds, sessionId, realPath);
  const metaMd = toMetaMarkdown(meta);

  writeFileSync(join(outDir, `${sessionId}.md`), md, 'utf-8');
  writeFileSync(join(outDir, `${sessionId}.meta.md`), metaMd, 'utf-8');

  return { sessionId, rounds: rounds.length, outDir };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

program
  .name('cc-export')
  .description('Export Claude Code sessions to Markdown')
  .version('1.0.0');

// list ────────────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List projects and sessions with summary')
  .option('--project <path>', 'Filter by real project path (partial match)')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const projects = listProjects();
    if (projects.length === 0) {
      console.log(chalk.yellow('No projects found.'));
      return;
    }

    const results = [];
    for (const project of projects) {
      const decoded = getProjectRealPath(project);
      if (opts.project && !decoded.includes(opts.project)) continue;

      const sessions = listSessions(project);
      for (const s of sessions) {
        try {
          const messages = parseSession(s.file);
          const rounds = buildConversation(messages);
          const timestamps = messages.filter(m => m.timestamp).map(m => m.timestamp).sort();
          const firstMsg = rounds[0]?.user?.split('\n')[0]?.slice(0, 60) || '(empty)';
          results.push({
            sessionId: s.name,
            project: decoded,
            rounds: rounds.length,
            startTime: timestamps[0] || null,
            firstMessage: firstMsg,
          });
        } catch {
          results.push({ sessionId: s.name, project: decoded, rounds: 0, startTime: null, firstMessage: '(parse error)' });
        }
      }
    }

    // sort by startTime desc
    results.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    for (const r of results) {
      const time = r.startTime ? new Date(r.startTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : 'N/A';
      console.log(chalk.bold.cyan(r.sessionId));
      console.log(`  ${chalk.gray(r.project)}`);
      console.log(`  ${chalk.green(r.rounds + ' rounds')}  ${chalk.gray(time)}`);
      console.log(`  ${r.firstMessage}`);
      console.log();
    }

    console.log(chalk.gray(`Total: ${results.length} sessions`));
  });

// export ──────────────────────────────────────────────────────────────────────
program
  .command('export')
  .description('Export a single session by ID')
  .requiredOption('--id <uuid>', 'Session UUID')
  .option('--from <n>', 'Start from round N', parseInt)
  .option('--to <n>', 'End at round N', parseInt)
  .action((opts) => {
    const found = findSessionById(opts.id);
    if (!found) {
      console.error(chalk.red(`Session not found: ${opts.id}`));
      process.exit(1);
    }

    found.realPath = getProjectRealPath(found.project);
    console.error(chalk.gray(`Found: ${found.file}`));

    const messages = parseSession(found.file);
    let rounds = buildConversation(messages);

    if (opts.from || opts.to) {
      const from = (opts.from || 1) - 1;
      const to = opts.to || rounds.length;
      rounds = rounds.slice(from, to);
    }

    if (rounds.length === 0) {
      console.error(chalk.yellow('No conversation rounds found.'));
      process.exit(1);
    }

    const outDir = sessionsOutputDir(found.realPath);
    mkdirSync(outDir, { recursive: true });

    const md = toMarkdown(rounds, opts.id);
    const meta = buildMeta(messages, rounds, opts.id, found.realPath);
    const metaMd = toMetaMarkdown(meta);

    writeFileSync(join(outDir, `${opts.id}.md`), md, 'utf-8');
    writeFileSync(join(outDir, `${opts.id}.meta.md`), metaMd, 'utf-8');

    console.error(chalk.green(`Exported ${rounds.length} rounds → ${outDir}`));
  });

// export-dir ──────────────────────────────────────────────────────────────────
program
  .command('export-dir <path>')
  .description('Export all sessions under a directory (and subdirectories)')
  .action((dirPath) => {
    const realPath = resolve(dirPath);
    const sessions = findSessionsByDir(realPath);

    if (sessions.length === 0) {
      console.log(chalk.yellow(`No sessions found under: ${realPath}`));
      return;
    }

    console.error(chalk.gray(`Found ${sessions.length} sessions under ${realPath}`));
    let ok = 0, skipped = 0;

    for (const s of sessions) {
      try {
        const result = exportSession(s);
        if (result.skipped) {
          console.error(chalk.yellow(`  SKIP ${s.name}: ${result.reason}`));
          skipped++;
        } else {
          console.error(chalk.green(`  OK   ${s.name} (${result.rounds} rounds) → ${result.outDir}`));
          ok++;
        }
      } catch (e) {
        console.error(chalk.red(`  ERR  ${s.name}: ${e.message}`));
        skipped++;
      }
    }

    console.error(chalk.bold(`\nDone: ${ok} exported, ${skipped} skipped`));
  });

// update ──────────────────────────────────────────────────────────────────────
program
  .command('update')
  .description('Re-export a single session (overwrite existing files)')
  .requiredOption('--id <uuid>', 'Session UUID')
  .action((opts) => {
    const found = findSessionById(opts.id);
    if (!found) {
      console.error(chalk.red(`Session not found: ${opts.id}`));
      process.exit(1);
    }

    found.realPath = getProjectRealPath(found.project);
    const result = exportSession(found);

    if (result.skipped) {
      console.error(chalk.yellow(`Skipped: ${result.reason}`));
    } else {
      console.error(chalk.green(`Updated ${result.rounds} rounds → ${result.outDir}`));
    }
  });

// update-dir ──────────────────────────────────────────────────────────────────
program
  .command('update-dir <path>')
  .description('Re-export all sessions under a directory (overwrite existing)')
  .action((dirPath) => {
    const realPath = resolve(dirPath);
    const sessions = findSessionsByDir(realPath);

    if (sessions.length === 0) {
      console.log(chalk.yellow(`No sessions found under: ${realPath}`));
      return;
    }

    console.error(chalk.gray(`Updating ${sessions.length} sessions under ${realPath}`));
    let ok = 0, skipped = 0;

    for (const s of sessions) {
      try {
        const result = exportSession(s);
        if (result.skipped) {
          console.error(chalk.yellow(`  SKIP ${s.name}: ${result.reason}`));
          skipped++;
        } else {
          console.error(chalk.green(`  OK   ${s.name} (${result.rounds} rounds)`));
          ok++;
        }
      } catch (e) {
        console.error(chalk.red(`  ERR  ${s.name}: ${e.message}`));
        skipped++;
      }
    }

    console.error(chalk.bold(`\nDone: ${ok} updated, ${skipped} skipped`));
  });

program.parse();

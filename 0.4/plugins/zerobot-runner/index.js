// ZeroBot 脚本机器人挂载（确定性型插件）v1.1
//
// 职责：让 ZeroBot-Plugin（Go 编写的指令型机器人：塔罗 / 运势 / 签到 / 表情包……）
// 与 QQ Agent 共用同一个 OneBot 协议端、同一个 QQ 账号 ——
//   1. 随本插件激活拉起 ZeroBot-Plugin.exe（-c config.json），崩溃自动看护重启；
//   2. 一并拉起 meme-generator 表情服务（端口 2233，已在监听则复用）；
//   3. before-tool 钩子拦截「模型自己发送脚本指令」，避免同一账号双执行；
//   4. available() 向插件页实时汇报 zbp 进程状态（红/绿 + 原因）；
//   5. 注册 status 工具，用户可以直接问模型"脚本机器人在线吗"。
//
// v1.1 的三个行为修正（都来自实机排查）：
//   · 子进程日志改走 cmd/sh 的 OS 级重定向（>> log 2>&1）——插件经管道捕获
//     子进程输出在 Electron GUI 主进程里从未生效（数据事件一次都不触发，
//     同款代码在纯 node / ELECTRON_RUN_AS_NODE 下均正常）；OS 重定向与
//     JS 数据事件无关，任何环境都不可能静默失败。
//   · 插件自身日志改走应用的 logger（api.log 只是 console.log，GUI 模式下
//     无处可去，两天里一条都没落盘）。
//   · 热重载不再杀子进程：杀毒/索引触碰插件目录会触发 fs.watch 误报 →
//     全量重载，旧版每次都把 zbp 杀掉重拉（用户看到的"莫名其妙掉线"）。
//     现在 deactivate(reason='reload') 保留子进程，新实例 activate 时直接
//     接管（配置签名一致才接管；用户手动开关仍然完整启停）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../src/logger.js';
import { skillManager } from '../../src/skills/manager.js';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');

const IS_WIN = process.platform === 'win32';
// 看护轮询：补拉子进程 / 响应设置变化。默认 15s；环境变量可覆盖（测试/调试用）。
const WATCH_INTERVAL_MS = Math.max(200, Number(process.env.ZEROBOT_RUNNER_WATCH_MS) || 15_000);
const RESTART_WINDOW_MS = 10 * 60_000;   // 崩溃重启的统计窗口
const MEME_PORT = 2233;
const CHILD_LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TAG = 'zerobot-runner';

let cfg = () => ({});

const log = (...a) => { try { logger.info(LOG_TAG, a.map(String).join(' ')); } catch { console.log(`[${LOG_TAG}]`, ...a); } };
const warn = (...a) => { try { logger.warn(LOG_TAG, a.map(String).join(' ')); } catch { console.warn(`[${LOG_TAG}]`, ...a); } };

// ── 跨热重载存活的运行状态 ─────────────────────────────────────────────
// 热重载会用新的模块实例替换本文件，但子进程与「进程退出兜底」必须跨实例存活：
// 挂到 globalThis 上；旧实例 deactivate 杀掉自己的子进程后，新实例接管状态对象。
const G = globalThis;
if (!G.__zerobotRunner) {
  G.__zerobotRunner = {
    zbp: null,        // { child, exe, dir, startedAt }
    meme: null,       // { child, dir, py, adopted, startedAt }
    timer: null,
    gen: 0,           // 代数：deactivate 自增，在途的异步 reconcile 据此放弃拉起
    lastSig: '',
    restarts: [],     // 崩溃重启时间戳（预算窗口）
    gaveUp: false,
    lastExitZbp: null // { code, signal, at } 最近一次 zbp 退出记录（排查用）
  };
}
const S = G.__zerobotRunner;

// 进程退出兜底：QQ Agent 的 stop() 不 dispose 技能，Electron 退出也只走 before-quit；
// 这里必须在 'exit'（同步阶段）里杀掉子进程，否则脚本机器人会变成孤儿继续跑。
// 只能注册一次：热重载的新实例不得重复挂监听。
if (!G.__zerobotRunnerExitHook) {
  G.__zerobotRunnerExitHook = true;
  process.on('exit', () => {
    for (const key of ['zbp', 'meme']) {
      const entry = G.__zerobotRunner?.[key];
      if (entry?.child?.pid) killTree(entry.child.pid);
    }
  });
}

// ── 小工具 ─────────────────────────────────────────────────────────────

function killTree(pid) {
  if (!pid || pid <= 0) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    }
  } catch { /* 兜底尽力而为，不向上抛 */ }
}

function killByImage(exePath) {
  if (!IS_WIN || !exePath) return;
  try {
    spawnSync('taskkill', ['/IM', path.basename(exePath), '/F'], { stdio: 'ignore', timeout: 8000 });
  } catch { /* ignore */ }
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

function childAlive(entry) {
  return Boolean(entry?.child?.pid && isAlive(entry.child.pid));
}

function probePort(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function asBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return String(v).trim().toLowerCase() === 'true';
}

function asInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/** 解析 ZeroBot-Plugin 的启动目标；null = 未配置（不拉起）。 */
function resolveZbp(c) {
  const dir = String(c.zbpDir || '').trim();
  if (!dir) return null;
  const exe = String(c.zbpExe || '').trim()
    || path.join(dir, IS_WIN ? 'ZeroBot-Plugin.exe' : 'ZeroBot-Plugin');
  if (!fs.existsSync(exe)) {
    return { error: `可执行文件不存在：${exe}（检查「ZeroBot-Plugin 目录 / 可执行文件」设置）` };
  }
  return { dir, exe };
}

/** 解析 meme-generator 的启动目标（依赖目录里的 .venv）；null = 未配置。 */
function resolveMeme(c) {
  const dir = String(c.memeDir || '').trim();
  if (!dir) return null;
  const candidates = IS_WIN
    ? [path.join(dir, '.venv', 'Scripts', 'python.exe')]
    : [path.join(dir, '.venv', 'bin', 'python'), path.join(dir, '.venv', 'bin', 'python3')];
  const py = candidates.find((p) => fs.existsSync(p));
  if (!py) {
    return { error: `meme-generator 虚拟环境不存在：${path.join(dir, '.venv')}（先在该目录完成安装）` };
  }
  return { dir, py };
}

/**
 * 拉起子进程并把输出交给 OS 级重定向写入日志文件。
 *
 * 为什么不自己接管道：插件在 Electron GUI 主进程里 spawn 的子进程，stdout/stderr
 * 的 data 事件实测一次都不触发（同款选项在纯 node 与 ELECTRON_RUN_AS_NODE 下都
 * 正常，应用自身拉 SnowLuma 也正常——原因未定位，但现象稳定复现）。改用
 * cmd /d /s /c "exe" args >> "log" 2>&1：cmd 自己开文件句柄传给子进程，
 * 不经过 JS 事件循环，不存在"静默丢日志"的路径。
 * 返回的 child 是 cmd/sh 包装进程：pid 用于整树查杀，退出码透传（cmd /c 语义）。
 */
function spawnLogged(exe, args, cwd, logFile, extraEnv = {}) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > CHILD_LOG_MAX_BYTES) {
      try { fs.renameSync(logFile, `${logFile}.old`); } catch { /* 滚动失败不影响启动 */ }
    }
  } catch { /* ignore */ }
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  if (IS_WIN) {
    // cross-spawn 同款技巧：整条命令再包一层外引号 + /s —— 没有外引号时 cmd 会把
    // 命令行里第一对引号当定界符剥掉（实测报 'C:\Program' 不是内部或外部命令）。
    const inner = [q(exe), ...args.map(q)].join(' ') + ` >> ${q(logFile)} 2>&1`;
    return spawn('cmd.exe', ['/d', '/s', '/c', `"` + inner + `"`], {
      cwd,
      windowsHide: true,
      // stdin 不是控制台时，zbp 的 abineundo 控制台插件会在 init 里 panic；
      // DEBUG_MODE=1 是它自带的逃生阀（仅跳过控制台模式设置，无其他副作用）。
      env: { ...process.env, DEBUG_MODE: '1', ...extraEnv },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsVerbatimArguments: true
    });
  }
  const sq = (s) => "'" + String(s).replace(/'/g, "'\''") + "'";
  const line = [sq(exe), ...args.map(sq)].join(' ') + ` >> ${sq(logFile)} 2>&1`;
  return spawn('/bin/sh', ['-c', line], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  });
}

/**
 * 解析代理设置并探测端口；不通则返回 null（回退直连——Clash 没开时
 * 代理变量只会坏事，直连至少保住 GitHub 源可达）。
 * 作用域仅 zbp 子进程：它要下载的签到背景（pic.re）与老婆/猪猪图库
 * （gitea.seku.su）在不通代理的情况下直连均被墙/卡死。
 * NO_PROXY 固定包含回环地址，OneBot 的 ws://127.0.0.1:3001 绝不走代理。
 */
async function resolveProxyEnv() {
  const raw = String(cfg().proxyUrl || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname || '127.0.0.1';
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    if (!(await probePort(port, host, 1200))) {
      warn(`代理 ${raw} 探测不通（代理软件没开？），本次直连`);
      return null;
    }
    return {
      HTTP_PROXY: raw, HTTPS_PROXY: raw,
      http_proxy: raw, https_proxy: raw,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'
    };
  } catch (e) {
    warn(`代理地址无效：${raw}（${e.message}）`);
    return null;
  }
}

/** 塔罗 AI 解析的接口配置（OpenAI 兼容端点），注入为 ZBP_AI_* 环境变量。 */
function aiEnvOf(c) {
  const api = String(c.aiApiUrl || '').trim();
  const key = String(c.aiApiKey || '').trim();
  if (!api || !key) return null;
  const env = { ZBP_AI_API: api, ZBP_AI_KEY: key };
  if (c.aiModel) env.ZBP_AI_MODEL = String(c.aiModel);
  const n = Number(c.aiMaxTokens);
  if (Number.isFinite(n) && n > 0) env.ZBP_AI_MAXN = String(Math.floor(n));
  return env;
}

async function spawnZbp(target) {
  const proxyEnv = await resolveProxyEnv();
  const aiEnv = aiEnvOf(cfg());
  const child = spawnLogged(
    target.exe,
    ['-c', path.join(target.dir, 'config.json')],
    target.dir,
    path.join(DATA_DIR, 'zerobot-runner-zbp.log'),
    { ...proxyEnv, ...aiEnv }
  );
  const entry = { child, exe: target.exe, dir: target.dir, startedAt: Date.now() };
  child.on('error', (e) => warn(`ZeroBot-Plugin 拉起失败：${e.message}`));
  child.on('exit', (code, signal) => {
    if (S.zbp === entry) {
      S.lastExitZbp = { code, signal, at: Date.now() };
      log(`ZeroBot-Plugin 已退出（code=${code} signal=${signal}），完整输出见 data/zerobot-runner-zbp.log`);
      reportHealth();
    }
  });
  S.zbp = entry;
  S.gaveUp = false;
  log(`ZeroBot-Plugin 已拉起：${target.exe}（pid=${child.pid}），输出记录到 data/zerobot-runner-zbp.log`
    + `${proxyEnv ? `，代理 ${cfg().proxyUrl}` : '，直连'}`
    + `${aiEnv ? '，AI 解析已配置' : ''}`);
  return entry;
}

async function spawnMeme(target) {
  // 端口已被占用时直接复用现有服务（手动起的 / 上次没退干净都算），不重复启动。
  if (await probePort(MEME_PORT)) {
    S.meme = { child: null, dir: target.dir, py: target.py, adopted: true, startedAt: Date.now() };
    log(`meme-generator：端口 ${MEME_PORT} 已有服务在监听，直接复用`);
    return;
  }
  const child = spawnLogged(
    target.py,
    ['-m', 'meme_generator.app'],
    target.dir,
    path.join(DATA_DIR, 'zerobot-runner-meme.log')
  );
  const entry = { child, dir: target.dir, py: target.py, adopted: false, startedAt: Date.now() };
  child.on('error', (e) => warn(`meme-generator 拉起失败：${e.message}`));
  child.on('exit', (code, signal) => {
    if (S.meme === entry) {
      log(`meme-generator 已退出（code=${code} signal=${signal}），完整输出见 data/zerobot-runner-meme.log`);
    }
  });
  S.meme = entry;
  log(`meme-generator 已拉起：${target.py}（pid=${child.pid}，端口 ${MEME_PORT}）`);
  return entry;
}

function stopZbp(reason) {
  const entry = S.zbp;
  if (!entry) return;
  if (childAlive(entry)) {
    log(`停止 ZeroBot-Plugin（${reason}）`);
    killTree(entry.child.pid);
  }
  S.zbp = null;
}

function stopMeme(reason) {
  const entry = S.meme;
  if (!entry) return;
  if (childAlive(entry)) {
    log(`停止 meme-generator（${reason}）`);
    killTree(entry.child.pid);
  }
  S.meme = null;
}

/** 崩溃重启预算：窗口内超限则放弃看护（避免死循环拉起）。 */
function budgetAllows() {
  const now = Date.now();
  S.restarts = S.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
  const max = asInt(cfg().restartBudget, 5);
  if (max <= 0) return false;
  if (S.restarts.length >= max) {
    if (!S.gaveUp) {
      S.gaveUp = true;
      warn(`ZeroBot-Plugin 在 ${RESTART_WINDOW_MS / 60000} 分钟内退出超过 ${max} 次，暂停自动重启；`
        + '请检查 data/zerobot-runner-zbp.log（通常是协议端没开或地址/令牌不对）。'
        + '修好后改一下插件设置、或关开一次本插件即可重试。');
    }
    return false;
  }
  S.restarts.push(now);
  return true;
}

/** 期望状态签名：变化（改路径 / 关自动启动）时平滑重启，不消耗崩溃预算。 */
function signatureOf(c, zbp, meme) {
  return JSON.stringify({
    a: asBool(c.autoStart, true),
    z: zbp && !zbp.error ? `${zbp.dir}|${zbp.exe}` : '',
    m: asBool(c.memeEnabled, true) && meme && !meme.error ? meme.dir : ''
  });
}

async function reconcile(reason) {
  const gen = S.gen;
  const c = cfg();
  const zbpTarget = resolveZbp(c);
  const memeTarget = resolveMeme(c);

  if (zbpTarget?.error || memeTarget?.error) {
    warn(`配置有误：${[zbpTarget?.error, memeTarget?.error].filter(Boolean).join('；')}`);
  }

  const sig = signatureOf(c, zbpTarget, memeTarget);
  const sigChanged = sig !== S.lastSig && S.lastSig !== '';
  if (sigChanged) {
    S.gaveUp = false;   // 用户改了配置：给一次新的机会，别被旧预算卡死
    log(`设置变化（${reason}），按新配置调整子进程`);
  }
  S.lastSig = sig;

  const zbpWanted = asBool(c.autoStart, true) && zbpTarget && !zbpTarget.error;
  const zbpRunning = childAlive(S.zbp);

  if (!zbpWanted) {
    if (S.zbp) stopZbp(reason);
  } else if (sigChanged && zbpRunning) {
    stopZbp('config-change');
    await spawnZbp(zbpTarget);
  } else if (!zbpRunning) {
    if (sigChanged || reason === 'activate' || budgetAllows()) {
      await spawnZbp(zbpTarget);
    }
  }

  const memeWanted = asBool(c.memeEnabled, true) && zbpWanted && memeTarget && !memeTarget.error;
  const memeRunning = childAlive(S.meme);

  if (!memeWanted) {
    if (S.meme) stopMeme(reason);
  } else if (sigChanged && memeRunning) {
    stopMeme('config-change');
    await spawnMeme(memeTarget);
  } else if (!memeRunning) {
    if (S.meme?.adopted) {
      // 之前是复用外部服务；再探一次，没了才自己拉（拉起动作自带端口探测）
      if (gen !== S.gen) return;
      if (!(await probePort(MEME_PORT))) {
        if (gen !== S.gen) return;
        await spawnMeme(memeTarget);
      }
    } else if (sigChanged || reason === 'activate' || budgetAllows()) {
      if (gen !== S.gen) return;
      await spawnMeme(memeTarget);
    }
  }
  reportHealth();
}

function startWatch() {
  if (S.timer) return;
  S.timer = setInterval(() => {
    reconcile('watch').catch((e) => warn(`看护轮询出错：${e?.message ?? e}`));
  }, WATCH_INTERVAL_MS);
  // 时间循环里不能拦着进程退出
  S.timer.unref?.();
}

function stopWatch() {
  if (!S.timer) return;
  clearInterval(S.timer);
  S.timer = null;
}

// ── 监测：状态快照（available() 与 status 工具共用）────────────────────

function fmtUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.floor(ms / 1000)}秒`;
  if (m < 60) return `${m}分钟`;
  return `${Math.floor(m / 60)}小时${m % 60}分`;
}

/** 任务管理器里可见的 ZeroBot-Plugin 进程 pid 列表（看护句柄是 cmd 包装层，用户对不上号）。 */
function listZbpProcesses() {
  try {
    const NL = String.fromCharCode(10);
    if (IS_WIN) {
      const out = (spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZeroBot-Plugin.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 5000 }).stdout || '');
      return out.split(NL).map((l) => l.split(',')[1]).filter((x) => x && x !== '"PID"').map((x) => x.replace(/"/g, ''));
    }
    const out = (spawnSync('pgrep', ['-f', 'ZeroBot-Plugin'], { encoding: 'utf8', timeout: 5000 }).stdout || '');
    return out.split(NL).flatMap((l) => l.split(String.fromCharCode(9))).map((x) => x.trim()).filter(Boolean);
  } catch { return []; }
}

function buildStatus() {
  const c = cfg();
  const zbpTarget = resolveZbp(c);
  const memeTarget = resolveMeme(c);
  const running = childAlive(S.zbp);
  const st = {
    configured: Boolean(zbpTarget && !zbpTarget.error),
    configError: zbpTarget?.error || memeTarget?.error || null,
    running,
    pid: running ? S.zbp.child.pid : null,
    uptime: running ? fmtUptime(Date.now() - (S.zbp.startedAt || Date.now())) : null,
    autoRestart: asBool(c.autoStart, true),
    gaveUp: Boolean(S.gaveUp),
    recentRestarts: S.restarts.length,
    lastExit: null
  };
  if (S.lastExitZbp) {
    st.lastExit = {
      code: S.lastExitZbp.code,
      signal: S.lastExitZbp.signal,
      ago: fmtUptime(Date.now() - S.lastExitZbp.at)
    };
  }
  return st;
}

// ── 插件生命周期 ───────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  // 状态查询工具：用户在 QQ 里问"zbp/脚本机器人/表情包服务 在吗、掉线了吗"时，
  // 模型调它拿实时进程状态，不再靠猜。分类用 query（工具分类表里没有 utility）。
  api.registerTool({
    id: 'status',
    name: '查询脚本机器人状态',
    description: '查询同账号 ZeroBot 脚本机器人（处理 /塔罗、/签到、「表情 petpet」等指令的另一个进程）的实时状态：是否运行、pid、已运行时长、近期重启次数、meme 表情服务端口是否在监听。用户问"脚本机器人/zbp 在不在、掉线了没、表情包还能用吗"时先调这个工具，用真实状态回答。',
    category: 'query',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const st = buildStatus();
      let memeUp = null;
      try { memeUp = await probePort(MEME_PORT); } catch { memeUp = null; }
      const lines = [];
      if (!st.configured) {
        lines.push('脚本机器人：未配置（插件设置里没填 ZeroBot-Plugin 目录）');
        if (st.configError) lines.push(`配置问题：${st.configError}`);
      } else if (st.running) {
        const pids = listZbpProcesses();
        lines.push(`脚本机器人：运行中${pids.length ? `（任务管理器 pid ${pids.join('/')}，已运行 ${st.uptime}）` : `（已运行 ${st.uptime}）`}`);
      } else if (st.gaveUp) {
        lines.push('脚本机器人：未运行——近期反复退出，自动看护已暂停（在插件设置里保存一次，或开关一次插件可重试）');
      } else {
        lines.push('脚本机器人：未运行');
      }
      if (st.lastExit) lines.push(`上次退出：code=${st.lastExit.code}（${st.lastExit.ago}前）`);
      if (st.recentRestarts > 0) lines.push(`近10分钟自动重启：${st.recentRestarts} 次`);
      lines.push(`meme 表情服务（端口 ${MEME_PORT}）：${memeUp === true ? '正常' : memeUp === false ? '未监听（表情合成不可用）' : '未知'}`);
      lines.push('详细日志：data/zerobot-runner-zbp.log');
      return { content: lines.join('\n') };
    }
  });
  log('ZeroBot 脚本机器人挂载插件已加载 v1.2（进程看护 + 状态查询 + 代理/AI 注入）');
}

/**
 * 插件本体永远可用（true）。
 *
 * ⚠️ 不要在这里回报 zbp 进程状态：available() 一旦 false，isActive 判定失效，
 * 本插件注册的 before-tool 守卫和 status 工具会**一起停摆**——而用户恰恰在
 * zbp 掉线时最需要问状态（"掉线了吗"），工具反而不可用就成了死循环。
 * zbp 的健康状态走 reportHealth()（插件页「上次出错」徽章）+ status 工具。
 */
export function available() {
  return true;
}

/**
 * 把 zbp 的健康状态写到技能注册表的 errors 槽（插件页显示为「上次出错」红字）。
 * 进程活着就清掉徽章；挂了/配置错就写明原因与修法。跨实例安全：包 try/catch。
 */
function reportHealth() {
  try {
    const c = cfg();
    const zbpTarget = resolveZbp(c);
    if (!zbpTarget) { skillManager.errors.delete('zerobot-runner'); return; }
    if (zbpTarget.error) {
      skillManager.errors.set('zerobot-runner', `配置有误：${zbpTarget.error}`);
      return;
    }
    if (childAlive(S.zbp)) { skillManager.errors.delete('zerobot-runner'); return; }
    const when = S.lastExitZbp ? `（上次退出 code=${S.lastExitZbp.code}，${fmtUptime(Date.now() - S.lastExitZbp.at)}前）` : '';
    skillManager.errors.set('zerobot-runner', S.gaveUp
      ? `ZeroBot-Plugin 反复退出已达上限，自动看护已暂停${when}——保存一次设置或开关一次插件即可重试；详见 data/zerobot-runner-zbp.log`
      : `ZeroBot-Plugin 进程未运行${when}，看护器会自动补拉；持续未恢复见 data/zerobot-runner-zbp.log`);
  } catch { /* 注册表不可用时静默降级（不影响进程看护本身） */ }
}

export function activate() {
  const c = cfg();
  const zbpTarget = resolveZbp(c);
  const memeTarget = resolveMeme(c);
  const sig = signatureOf(c, zbpTarget, memeTarget);
  // 接管路径：热重载前留下的健康子进程 + 配置没变 → 直接接管，不打断机器人。
  // （deactivate(reason='reload') 不杀子进程；这里必须跳过 killByImage，
  //   否则刚保下来的进程会被自己按同名清场误杀。）
  const adopting = childAlive(S.zbp) && zbpTarget && !zbpTarget.error && sig === S.lastSig;
  if (adopting) {
    log(`接管热重载前的子进程（ZeroBot-Plugin pid=${S.zbp.child.pid}，不重启）`);
  } else if (zbpTarget && !zbpTarget.error && asBool(c.killExisting, true)) {
    // 全新启动：清掉同名残留（手动开着或上次没退干净的实例连同一协议端会双回复）
    killByImage(zbpTarget.exe);
  }
  S.gaveUp = false;
  startWatch();
  reconcile('activate').catch((e) => warn(`激活时拉起失败：${e?.message ?? e}`));
}

export function deactivate({ reason } = {}) {
  S.gen += 1;
  stopWatch();
  // 热重载（含 fs.watch 误报触发的全量重扫）：子进程保持运行，新实例 activate
  // 会直接接管。真正要停的是用户开关、卸载、退出这几类。
  if (reason === 'reload') {
    log(`热重载：子进程保持运行（zbp pid=${S.zbp?.child?.pid ?? '-'}），由新实例接管`);
    return;
  }
  stopZbp(`deactivate${reason ? `:${reason}` : ''}`);
  stopMeme(`deactivate${reason ? `:${reason}` : ''}`);
}

export function dispose() {
  S.gen += 1;
  stopWatch();
  stopZbp('dispose');
  stopMeme('dispose');
}

// ── 确定性守卫：模型不得替脚本机器人执行指令 ────────────────────────────
// 同一账号上有两个"脑"：模型若把「/塔罗」当自己的话发出去，脚本机器人也会
// 收到并执行，用户就会看到重复回复。这里在工具执行前直接否决。
export const hooks = {
  'before-tool': ({ toolName, argsRaw } = {}) => {
    try {
      if (!asBool(cfg().guardModelSends, true)) return;
      if (toolName !== 'send_message' && toolName !== 'send_to') return;
      const prefixes = String(cfg().commandPrefixes ?? '/')
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!prefixes.length) return;

      let args = argsRaw;
      if (typeof args === 'string') args = JSON.parse(args || '{}');
      if (!args || typeof args !== 'object') return;
      const messages = Array.isArray(args.messages) ? args.messages : [args.messages];
      const hit = messages
        .filter((m) => typeof m === 'string')
        .map((m) => m.trim())
        .find((m) => m && prefixes.some((p) => m.startsWith(p)));
      if (!hit) return;
      return {
        block: true,
        reason: `「${hit.slice(0, 40)}」以 ${prefixes.join('/')} 开头，是脚本机器人（ZeroBot）的指令，由另一个进程直接处理，你不要替它发送或扮演执行结果。请用你自己的口吻回复用户。`
      };
    } catch {
      return; // 守卫自身出错时放行，不能拖垮正常发送
    }
  }
};

// 仅供测试使用：wrapper 与状态构造在测试里做真实行为验证。
export const __test = { spawnLogged, buildStatus };
export const __reportHealthForTest = reportHealth;

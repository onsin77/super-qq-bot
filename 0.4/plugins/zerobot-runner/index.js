// ZeroBot 脚本机器人挂载（确定性型插件）
//
// 职责：让 ZeroBot-Plugin（Go 编写的指令型机器人：塔罗 / 运势 / 签到 / 表情包……）
// 与 QQ Agent 共用同一个 OneBot 协议端、同一个 QQ 账号 ——
//   1. 随本插件激活拉起 ZeroBot-Plugin.exe（-c config.json），崩溃自动看护重启；
//   2. 一并拉起 meme-generator 表情服务（端口 2233，已在监听则复用）；
//   3. before-tool 钩子拦截「模型自己发送脚本指令」，避免同一账号双执行。
//
// 两个子进程都是独立的 WS 客户端，各自连协议端；QQ Agent 退出时它们一起被带走。
// AI 聊天完全由 QQ Agent 负责 —— ZeroBot-Plugin 侧应已去掉大模型聊天插件。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');

const IS_WIN = process.platform === 'win32';
// 看护轮询：补拉子进程 / 响应设置变化。默认 15s；环境变量可覆盖（测试/调试用）。
const WATCH_INTERVAL_MS = Math.max(200, Number(process.env.ZEROBOT_RUNNER_WATCH_MS) || 15_000);
const RESTART_WINDOW_MS = 10 * 60_000;   // 崩溃重启的统计窗口
const MEME_PORT = 2233;
const CHILD_LOG_MAX_BYTES = 5 * 1024 * 1024;

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// ── 跨热重载存活的运行状态 ─────────────────────────────────────────────
// 热重载会用新的模块实例替换本文件，但子进程与「进程退出兜底」必须跨实例存活：
// 挂到 globalThis 上，旧实例 deactivate 杀掉自己的子进程后，新实例接管状态对象。
const G = globalThis;
if (!G.__zerobotRunner) {
  G.__zerobotRunner = {
    zbp: null,        // { child, exe, dir, logStream }
    meme: null,       // { child, dir, adopted }
    timer: null,
    gen: 0,           // 代数：deactivate 自增，在途的异步 reconcile 据此放弃拉起
    lastSig: '',
    restarts: [],     // 崩溃重启时间戳（预算窗口）
    gaveUp: false,
    lastSpamLog: 0
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

/** 子进程输出 → 落盘 + 选摘转发（避免把整屏日志灌进应用日志）。 */
function attachOutput(entry, name, childLogPath) {
  try {
    try {
      if (fs.existsSync(childLogPath) && fs.statSync(childLogPath).size > CHILD_LOG_MAX_BYTES) {
        fs.renameSync(childLogPath, `${childLogPath}.old`);
      }
    } catch { /* 滚动失败不影响启动 */ }
    const stream = fs.createWriteStream(childLogPath, { flags: 'a' });
    entry.logStream = stream;
    let buf = '';
    const consume = (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        try { stream.write(line + '\n'); } catch { /* ignore */ }
        // 只转发「值得看见」的行，且全局限频：协议端没开时子进程每 2 秒刷一条
        // 重连警告，全量转发会把应用日志淹掉。
        if (/error|panic|fatal|失败|错误|exited|连接.{0,12}(失败|错误)/i.test(line)) {
          const now = Date.now();
          if (now - S.lastSpamLog > 60_000) {
            S.lastSpamLog = now;
            warn(`[${name}] ${line.slice(0, 300)}`);
          }
        }
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
  } catch { /* 日志挂接失败不影响运行 */ }
}

function detachOutput(entry) {
  try { entry.logStream?.end(); } catch { /* ignore */ }
  entry.logStream = null;
}

function spawnZbp(target) {
  const child = spawn(target.exe, ['-c', path.join(target.dir, 'config.json')], {
    cwd: target.dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN,
    // stdin 不是控制台时，zbp 的 abineundo 控制台插件会在 init 里 panic；
    // DEBUG_MODE=1 是它自带的逃生阀（仅跳过控制台模式设置，无其他副作用）。
    env: { ...process.env, DEBUG_MODE: '1' }
  });
  const entry = { child, exe: target.exe, dir: target.dir, logStream: null };
  attachOutput(entry, 'zerobot', path.join(DATA_DIR, 'zerobot-runner-zbp.log'));
  child.on('error', (e) => warn(`ZeroBot-Plugin 拉起失败：${e.message}`));
  child.on('exit', (code, signal) => {
    if (S.zbp === entry) {
      log(`ZeroBot-Plugin 已退出（code=${code} signal=${signal}），详细输出见 data/zerobot-runner-zbp.log`);
      detachOutput(entry);
    }
  });
  S.zbp = entry;
  S.gaveUp = false;
  log(`ZeroBot-Plugin 已拉起：${target.exe}（pid=${child.pid}）`);
  return entry;
}

async function spawnMeme(target) {
  // 端口已被占用时直接复用现有服务（手动起的 / 上次没退干净都算），不重复启动。
  if (await probePort(MEME_PORT)) {
    S.meme = { child: null, dir: target.dir, adopted: true };
    log(`meme-generator：端口 ${MEME_PORT} 已有服务在监听，直接复用`);
    return;
  }
  const child = spawn(target.py, ['-m', 'meme_generator.app'], {
    cwd: target.dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN
  });
  const entry = { child, dir: target.dir, py: target.py, logStream: null, adopted: false };
  attachOutput(entry, 'meme', path.join(DATA_DIR, 'zerobot-runner-meme.log'));
  child.on('error', (e) => warn(`meme-generator 拉起失败：${e.message}`));
  child.on('exit', (code, signal) => {
    if (S.meme === entry) {
      log(`meme-generator 已退出（code=${code} signal=${signal}），详细输出见 data/zerobot-runner-meme.log`);
      detachOutput(entry);
    }
  });
  S.meme = entry;
  log(`meme-generator 已拉起：${target.py}（pid=${child.pid}，端口 ${MEME_PORT}）`);
  return entry;
}

function stopZbp(reason) {
  const entry = S.zbp;
  if (!entry) return;
  if (entry.child?.pid && isAlive(entry.child.pid)) {
    log(`停止 ZeroBot-Plugin（${reason}）`);
    killTree(entry.child.pid);
  }
  detachOutput(entry);
  S.zbp = null;
}

function stopMeme(reason) {
  const entry = S.meme;
  if (!entry) return;
  if (entry.child?.pid && isAlive(entry.child.pid)) {
    log(`停止 meme-generator（${reason}）`);
    killTree(entry.child.pid);
  }
  detachOutput(entry);
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
  const zbpRunning = S.zbp?.child?.pid && isAlive(S.zbp.child.pid);

  if (!zbpWanted) {
    if (S.zbp) stopZbp(reason);
  } else if (sigChanged && zbpRunning) {
    stopZbp('config-change');
    spawnZbp(zbpTarget);
  } else if (!zbpRunning) {
    if (sigChanged || reason === 'activate' || budgetAllows()) {
      spawnZbp(zbpTarget);
    }
  }

  const memeWanted = asBool(c.memeEnabled, true) && zbpWanted && memeTarget && !memeTarget.error;
  const memeRunning = S.meme?.child?.pid && isAlive(S.meme.child.pid);

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

// ── 插件生命周期 ───────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;
  log('ZeroBot 脚本机器人挂载插件已加载（在设置里填好目录并启用后生效）');
}

export function activate() {
  const c = cfg();
  // 激活时清理同名残留：手动开着或上次崩溃没退干净的实例连同一个协议端会导致
  // 每条消息被处理两遍，必须先清场再拉起（可用 killExisting 关闭该行为）。
  const zbpTarget = resolveZbp(c);
  if (zbpTarget && !zbpTarget.error && asBool(c.killExisting, true)) {
    killByImage(zbpTarget.exe);
  }
  S.gaveUp = false;
  startWatch();
  reconcile('activate').catch((e) => warn(`激活时拉起失败：${e?.message ?? e}`));
}

export function deactivate({ reason } = {}) {
  S.gen += 1;
  stopWatch();
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

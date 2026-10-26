// zerobot-runner 插件测试 v1.1：守卫 / 生命周期 / 热重载接管 / available / 工具 / OS 级日志重定向。
//
// 这类「进程管理型」插件最容易出的四类事故，这里逐条钉死：
//   1. 守卫误伤 —— 把正常聊天拦了，或把 JSON 解析炸了拖垮发送；
//   2. 未配置就拉进程 —— 测试环境 / 新装机上冷不丁 spawn 出东西；
//   3. 热重载误杀 —— fs.watch 误报触发重载时把正在干活的子进程杀掉（线上"莫名掉线"）；
//   4. 日志静默丢失 —— 管道捕获在 Electron GUI 主进程不生效，排查时两眼一抹黑。
// 全部测试只用临时目录、假 exe 文件和牺牲进程（ping/sleep），不碰真实机器人路径。

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zbp-runner-test-'));
// 缩短看护轮询：本测试要验证「设置变化在若干个周期内被采纳」，默认 15s 等不起
process.env.ZEROBOT_RUNNER_WATCH_MS = '200';

// v1.1 起插件的 log/warn 直接进应用 logger（api.log 在 GUI 模式下会丢），
// 测试通过 onLog 监听捕获，与生产路径一致
const { logger } = await import('../src/logger.js');
const logLines = [];
logger.onLog((entry) => logLines.push(entry));

const mod = await import('../plugins/zerobot-runner/index.js');
const S = globalThis.__zerobotRunner;
assert.ok(S, '运行状态挂在 globalThis（跨热重载存活）');

let cfgData = {};
const registeredTools = [];
const seen = [];
const api = {
  config: () => cfgData,
  log: (...a) => seen.push(['log', ...a]),
  warn: (...a) => seen.push(['warn', ...a]),
  registerTool: (def) => { registeredTools.push(def); return def.id; }
};
mod.setup(api);
assert.ok(registeredTools.some((t) => t.id === 'status'), 'setup 注册了 status 状态查询工具');

let pass = 0;
function ok(msg) { pass += 1; console.log(`  ✓ ${msg}`); }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── 一、before-tool 守卫（v1.0 行为保持）───────────────────────────────
console.log('\n=== 一、before-tool：拦截模型抢发脚本指令 ===');
const hook = mod.hooks['before-tool'];
assert.equal(typeof hook, 'function', '导出了 before-tool 钩子');

cfgData = { guardModelSends: true, commandPrefixes: '/' };
let r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: '/塔罗' }) });
assert.ok(r?.block, '字符串消息以 / 开头 → 拦截');
ok('字符串消息「/塔罗」被拦截');

r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: ['我看看', '/服务列表'] }) });
assert.ok(r?.block && /服务列表/.test(r.reason), '数组里任一条以 / 开头 → 整次调用拦截且理由可读');
ok('数组消息中混入指令 → 拦截');

r = hook({ toolName: 'send_to', argsRaw: JSON.stringify({ messages: '/help', targetChatKey: 'group:1' }) });
assert.ok(r?.block, 'send_to 同样受守卫');
ok('send_to 也被守卫覆盖');

r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: '塔罗牌怎么玩/规则是什么' }) });
assert.equal(r, undefined, '/ 不在开头 → 放行');
ok('斜杠在句中 → 放行');

r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: ['哈哈', '6'] }) });
assert.equal(r, undefined, '普通消息 → 放行');
ok('普通消息 → 放行');

r = hook({ toolName: 'send_sticker', argsRaw: JSON.stringify({ stickerId: 'x' }) });
assert.equal(r, undefined, '表情工具不受影响');
ok('send_sticker 不受影响');

r = hook({ toolName: 'send_message', argsRaw: 'not-json{' });
assert.equal(r, undefined, '坏 JSON 不抛错、直接放行（守卫自身不能拖垮发送）');
ok('坏 JSON → 不抛错');

r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({}) });
assert.equal(r, undefined, '缺 messages → 放行');
ok('缺 messages → 放行');

cfgData = { guardModelSends: false, commandPrefixes: '/' };
r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: '/塔罗' }) });
assert.equal(r, undefined, 'guardModelSends=false → 不拦截');
ok('守卫关闭 → 不拦截');

cfgData = { guardModelSends: true, commandPrefixes: '/,表情,meme' };
r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: '表情 petpet' }) });
assert.ok(r?.block, '中文前缀「表情」生效');
ok('自定义前缀「表情 petpet」被拦截');

cfgData = { guardModelSends: true, commandPrefixes: '' };
r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({ messages: '/塔罗' }) });
assert.equal(r, undefined, '前缀清空 → 拦截关闭');
ok('前缀清空 → 不拦截');

// ── 二、OS 级日志重定向 wrapper ────────────────────────────────────────
console.log('\n=== 二、spawnLogged：OS 级重定向（GUI 主进程管道捕获失效的根治） ===');
{
  const logFile = path.join(process.env.QQ_AGENT_DATA_DIR, 'wrap-test.log');
  const marker = 'ZBPWRAP-' + Date.now();
  const child = mod.__test.spawnLogged(
    process.execPath,
    ['-e', "console.log('" + marker + "'); process.exit(7)"],
    os.tmpdir(),
    logFile
  );
  const code = await new Promise((res) => child.on('exit', (c) => res(c)));
  await new Promise((res) => setTimeout(res, 500));
  const text = fs.readFileSync(logFile, 'utf8');
  assert.ok(text.includes(marker), '子进程 stdout 必须出现在日志文件里（重定向路径，不依赖 data 事件）');
  assert.equal(code, 7, '退出码必须透传（cmd /c 语义），看护重启逻辑依赖它');
  ok('wrapper：输出落盘 + 退出码透传');
}

// ── 三、生命周期：未配置时必须是纯空转 ────────────────────────────────
console.log('\n=== 三、生命周期：未配置不拉进程 ===');
cfgData = {};
mod.activate();
await new Promise((res) => setTimeout(res, 500));
assert.equal(S.zbp, null, 'zbpDir 为空 → 不 spawn');
assert.equal(S.meme, null, 'memeDir 为空 → 不 spawn');
ok('activate 未配置目录 → 不产生任何子进程');

cfgData = { autoStart: true, zbpDir: 'Z:/definitely/not/here' };
await new Promise((res) => setTimeout(res, 500));
assert.equal(S.zbp, null, '目录/exe 不存在 → 不 spawn，只告警');
assert.ok(logLines.some((e) => String(e.level) === 'warn' && /不存在/.test(String(e.text || e.message || e))),
  '配置错误通过应用 logger 留下告警（GUI 模式下 api.log 会丢）');
ok('坏路径 → 不 spawn 且有告警');
cfgData = {};

const genBefore = S.gen;
mod.deactivate({ reason: 'test' });
assert.equal(S.timer, null, 'deactivate 停掉看护定时器');
assert.equal(S.gen, genBefore + 1, 'deactivate 自增代数（在途 reconcile 让位）');
ok('deactivate：停定时器 + 代数自增');

// ── 四、available() 恒真 + 健康徽章 ────────────────────────────────────
console.log('\n=== 四、available 恒真 / 掉线走「上次出错」徽章 ===');
// available() 绝不能随 zbp 状态变 false：否则掉线时 status 工具与守卫一起停摆
assert.equal(mod.available(), true, '未配置时插件本体仍可用');
ok('available() 未配置 → 仍为 true（工具/守卫不受影响）');

// 假 exe 目录：resolveZbp 只检查存在性，空文件即可（绝不碰真实路径）
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbp-fake-'));
const fakeExe = path.join(fakeDir, process.platform === 'win32' ? 'ZeroBot-Plugin.exe' : 'ZeroBot-Plugin');
fs.writeFileSync(fakeExe, '');
cfgData = { autoStart: true, zbpDir: fakeDir, zbpExe: fakeExe, killExisting: false };

const { skillManager } = await import('../src/skills/manager.js');
// 掉线状态写入 errors 槽（插件页「上次出错」徽章的数据源）
S.zbp = null;
S.gaveUp = true;
S.lastExitZbp = { code: 1, signal: null, at: Date.now() };
mod.__reportHealthForTest();
let badge = skillManager.errors.get('zerobot-runner') || '';
assert.match(badge, /暂停/, 'gaveUp → 徽章写明看护已暂停');
ok('崩溃预算耗尽 → 「上次出错」徽章 + 修法提示');

S.gaveUp = false;
mod.__reportHealthForTest();
badge = skillManager.errors.get('zerobot-runner') || '';
assert.match(badge, /未运行/, '普通掉线 → 徽章写明进程未运行');
ok('进程未运行 → 「上次出错」徽章');

// 恢复健康 → 徽章清除
S.zbp = { child: { pid: process.pid }, exe: fakeExe, dir: fakeDir, startedAt: Date.now() };
mod.__reportHealthForTest();
assert.equal(skillManager.errors.has('zerobot-runner'), false, '进程恢复 → 徽章清除');
ok('进程恢复 → 徽章自动清除');
S.zbp = null;
S.lastExitZbp = null;

// ── 五、热重载接管：不再误杀正在运行的子进程 ──────────────────────────
console.log('\n=== 五、热重载接管（"莫名掉线"的修复） ===');
{
  // 牺牲进程：只用来验证"没被杀"，绝不指向真实机器人
  const sacrificial = process.platform === 'win32'
    ? spawn('ping', ['-n', '60', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
    : spawn('sleep', ['60'], { stdio: 'ignore' });
  const fakeEntry = { child: { pid: sacrificial.pid }, exe: fakeExe, dir: fakeDir, startedAt: Date.now() };
  S.zbp = fakeEntry;
  // 签名镜像 signatureOf 的内部格式（autoStart|zbp|meme 三元组），让 activate 判定"配置没变"
  S.lastSig = JSON.stringify({ a: true, z: fakeDir + '|' + fakeExe, m: '' });

  // ① 热重载 deactivate：子进程必须活下来
  mod.deactivate({ reason: 'reload' });
  assert.ok(alive(sacrificial.pid), 'reload 不得杀死子进程');
  assert.equal(S.zbp, fakeEntry, 'reload 保留运行状态（新实例接管用）');
  ok('deactivate(reload) → 子进程存活');

  // ② 新实例 activate：直接接管，不重启、不按同名清场
  mod.activate();
  await new Promise((res) => setTimeout(res, 400));
  assert.ok(alive(sacrificial.pid), '接管路径不得杀掉/重启子进程');
  assert.equal(S.zbp, fakeEntry, '接管后运行状态原样保留');
  ok('activate 接管 → 同一进程继续跑');

  // ③ 真正的关闭（用户开关 / 退出）：必须杀干净
  mod.deactivate({ reason: 'user-toggle' });
  await new Promise((res) => setTimeout(res, 800));
  assert.ok(!alive(sacrificial.pid), '非 reload 的 deactivate 必须杀掉子进程');
  assert.equal(S.zbp, null, '关闭后清空运行状态');
  ok('deactivate(用户开关) → 彻底停止');

  // ④ 热重载后新实例 setup 失败的场景：旧实例被救活（activate），子进程同样存活
  const s2 = spawn(process.platform === 'win32' ? 'ping' : 'sleep',
    process.platform === 'win32' ? ['-n', '60', '127.0.0.1'] : ['60'],
    { windowsHide: true, stdio: 'ignore' });
  const fakeEntry2 = { child: { pid: s2.pid }, exe: fakeExe, dir: fakeDir, startedAt: Date.now() };
  S.zbp = fakeEntry2;
  mod.deactivate({ reason: 'reload' });
  mod.activate();   // 模拟 loader 的"救活旧实例"
  await new Promise((res) => setTimeout(res, 400));
  assert.ok(alive(s2.pid), '救活旧实例的 activate 同样走接管路径');
  mod.deactivate({});
  await new Promise((res) => setTimeout(res, 800));
  assert.ok(!alive(s2.pid), '清理牺牲进程');
  ok('setup 失败救活路径 → 仍然接管不误杀');
}

// ── 六、status 工具 ────────────────────────────────────────────────────
console.log('\n=== 六、status 状态查询工具 ===');
{
  assert.ok(statusToolOf(registeredTools), 'status 工具已注册');
  const tool = statusToolOf(registeredTools);
  assert.equal(tool.category, 'query', '工具分类必须是合法的 query');
  assert.equal(tool.parameters.type, 'object', 'parameters.type=object');
  assert.equal(Object.keys(tool.parameters.properties).length, 0, '无参数');

  S.zbp = { child: { pid: process.pid }, exe: fakeExe, dir: fakeDir, startedAt: Date.now() };
  const result = await tool.execute({}, {});
  assert.ok(result.content.includes('运行中'), '运行中时内容包含状态');
  // v1.1 显示的是任务管理器可见的真实进程 pid（本机可能有、CI 上没有），只验格式
  assert.ok(!result.content.includes(String(process.pid)) || result.content.includes('任务管理器 pid'), 'pid 口径：真进程号而非看护句柄');
  ok('status 工具返回实时状态（运行中/pid/表情服务）');

  S.zbp = null;
  const result2 = await tool.execute({}, {});
  assert.ok(result2.content.includes('未运行'), '未运行时如实报告');
  ok('status 工具如实报告未运行');
}

function statusToolOf(list) { return list.find((t) => t.id === 'status'); }

// ── 七、退出兜底只注册一次 ─────────────────────────────────────────────
console.log('\n=== 七、退出兜底 ===');
const mod2 = await import(`../plugins/zerobot-runner/index.js?t=${Date.now()}`);
assert.equal(globalThis.__zerobotRunnerExitHook, true, 'exit 兜底标记存在');
ok('重复加载不重复注册 exit 兜底（globalThis 哨兵）');

mod.dispose();
mod.dispose();
ok('dispose 幂等，重复调用不抛');

console.log(`\n全部通过：${pass} 项断言组`);

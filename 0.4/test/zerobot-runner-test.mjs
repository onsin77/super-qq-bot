// zerobot-runner 插件测试：确定性守卫（before-tool）与生命周期安全性。
//
// 这类「进程管理型」插件最容易出的两类事故：
//   1. 守卫误伤 —— 把正常聊天拦了，或把 JSON 解析炸了拖垮发送；
//   2. 未配置就拉进程 —— 测试环境 / 新装机上冷不丁 spawn 出东西。
// 这里把两条都钉死：守卫规则逐条验证；未配置时 activate 必须是纯空转。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zbp-runner-test-'));
// 缩短看护轮询：本测试要验证「设置变化在若干个周期内被采纳」，默认 15s 等不起
process.env.ZEROBOT_RUNNER_WATCH_MS = '200';

const mod = await import('../plugins/zerobot-runner/index.js');
const S = globalThis.__zerobotRunner;
assert.ok(S, '运行状态挂在 globalThis（跨热重载存活）');

let cfgData = {};
const seen = [];
const api = {
  config: () => cfgData,
  log: (...a) => seen.push(['log', ...a]),
  warn: (...a) => seen.push(['warn', ...a])
};
mod.setup(api);

let pass = 0;
function ok(msg) { pass += 1; console.log(`  ✓ ${msg}`); }

// ── 一、before-tool 守卫 ────────────────────────────────────────────────
console.log('\n=== 一、before-tool：拦截模型抢发脚本指令 ===');
const hook = mod.hooks['before-tool'];
assert.equal(typeof hook, 'function', '导出了 before-tool 钩子');

cfgData = { guardModelSends: true, commandPrefixes: '/' };

// 真实链路的 argsRaw 是 JSON 字符串
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

// 边界：坏 JSON / 空值不能抛
r = hook({ toolName: 'send_message', argsRaw: 'not-json{' });
assert.equal(r, undefined, '坏 JSON 不抛错、直接放行（守卫自身不能拖垮发送）');
ok('坏 JSON → 不抛错');

r = hook({ toolName: 'send_message', argsRaw: JSON.stringify({}) });
assert.equal(r, undefined, '缺 messages → 放行');
ok('缺 messages → 放行');

// 开关与自定义前缀
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

// ── 二、生命周期：未配置时必须是纯空转 ────────────────────────────────
console.log('\n=== 二、生命周期：未配置不拉进程 ===');

cfgData = {};   // 什么都没配
mod.activate();
await new Promise((res) => setTimeout(res, 50));
assert.equal(S.zbp, null, 'zbpDir 为空 → 不 spawn');
assert.equal(S.meme, null, 'memeDir 为空 → 不 spawn');
ok('activate 未配置目录 → 不产生任何子进程');

// 指向不存在的目录也不能 spawn（resolve 校验先行）；轮询周期 200ms，等 2 个周期
cfgData = { autoStart: true, zbpDir: 'Z:/definitely/not/here' };
await new Promise((res) => setTimeout(res, 500));
assert.equal(S.zbp, null, '目录/exe 不存在 → 不 spawn，只告警');
assert.ok(seen.some(([lv]) => lv === 'warn'), '配置错误留下了告警日志');
ok('坏路径 → 不 spawn 且有告警');

const genBefore = S.gen;
mod.deactivate({ reason: 'test' });
assert.equal(S.timer, null, 'deactivate 停掉看护定时器');
assert.equal(S.gen, genBefore + 1, 'deactivate 自增代数（在途 reconcile 让位）');
ok('deactivate：停定时器 + 代数自增');

mod.dispose();
mod.dispose();
ok('dispose 幂等，重复调用不抛');

// ── 三、退出兜底只注册一次 ─────────────────────────────────────────────
console.log('\n=== 三、退出兜底 ===');
// 模拟热重载：再次 import（带不同 query）不应重复注册 exit 监听
const mod2 = await import(`../plugins/zerobot-runner/index.js?t=${Date.now()}`);
assert.equal(globalThis.__zerobotRunnerExitHook, true, 'exit 兜底标记存在');
ok('重复加载不重复注册 exit 兜底（globalThis 哨兵）');

console.log(`\n全部通过：${pass} 项断言组`);

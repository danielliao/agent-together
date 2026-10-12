#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MemberAgent } from '../src/member.mjs';
import { McpError } from '../src/mcp.mjs';
import { publicText } from '../src/history.mjs';

const HELP = `一起来麦：成员自己的本机 Agent\n\nnode scripts/member.mjs collect --profile profiles/me.private.json\nnode scripts/member.mjs quote --profile profiles/me.private.json --input work/quote-task.json\nnode scripts/member.mjs worker --profile profiles/me.private.json --coordinator https://your-room.example\nnode scripts/member.mjs approve --profile profiles/me.private.json --coordinator https://your-room.example --plan-hash <当前方案SHA256>\nnode scripts/member.mjs payment --profile profiles/me.private.json --reference <本机订单引用>\nnode scripts/member.mjs reconcile --profile profiles/me.private.json --reference <本机订单引用> --order-id <本人核实的订单号>\n\nMCD_MCP_TOKEN 仅供本机 Agent 请求官方 MCP。\nTOGETHER_AGENT_SECRET 仅供该成员连接协调器，不能填麦当劳 Token。\nworker 不会自动批准方案；approve 需主人在本机确认当前哈希。\n支付链接只在付款主人的本机 payment 命令显示，不发送给协调器。\nprofile 中的 history.shared 必须为 true 才分享近期餐品频次摘要。\n`;

function fail(code, message) { throw new McpError(code, message); }
async function jsonFile(path) {
  try {
    const raw = await readFile(resolve(path));
    if (raw.length > 1024 * 1024) fail('invalid_local_file', '本机 JSON 超过允许大小。');
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    if (error instanceof McpError) throw error;
    fail('invalid_local_file', '本机 JSON 不可读取或格式无效；内容及路径已隐藏。');
  }
}
export function coordinatorURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_coordinator', '请提供有效的协调器地址。'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('invalid_coordinator', '协调器须为 HTTPS 或本机回环 HTTP 的根地址，不可包含凭证。');
  return url.origin;
}
export async function coordinatorRequest(base, route, { secret, agent_id, method = 'POST', body, fetchImpl = fetch } = {}) {
  const origin = coordinatorURL(base);
  if (typeof secret !== 'string' || !secret.trim() || secret.trim() === process.env.MCD_MCP_TOKEN?.trim()) fail('missing_agent_secret', '请设置该成员独立的 TOGETHER_AGENT_SECRET，不能使用麦当劳 Token。');
  const url = new URL(route, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/agent/')) fail('invalid_coordinator_route', '协调器任务路径无效。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify({ ...body, agent_id }) }), signal: controller.signal, redirect: 'error', cache: 'no-store' });
    if (!response.ok) fail('coordinator_request_failed', `协调器请求失败（HTTP ${response.status}）；错误正文已隐藏。`);
    const data = await response.json();
    if (!data || typeof data !== 'object') fail('invalid_coordinator_response', '协调器响应格式未经确认。');
    return data;
  } catch (error) {
    if (error instanceof McpError) throw error;
    fail(controller.signal.aborted ? 'coordinator_timeout' : 'coordinator_unavailable', '协调器未连接成功；未声称已完成多人真实联调。');
  } finally { clearTimeout(timer); }
}

function ownBillDetails(bill, agentId) {
  if (bill?.agent_id !== agentId) fail('wrong_bill_recipient', '协调器账单不属于本机主人，未展示或确认送达。');
  const output = { agent_id: agentId };
  for (const key of ['food_cents', 'discount_cents', 'delivery_cents', 'payable_cents']) {
    if (bill[key] !== undefined) {
      if (!Number.isSafeInteger(bill[key]) || bill[key] < 0) fail('invalid_bill', '本人分账明细必须是非负整数分。');
      output[key] = bill[key];
    }
  }
  return output;
}

export async function processTask(member, task) {
  if (!task || typeof task.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(task.id)) fail('invalid_coordinator_task', '协调器任务标识无效。');
  switch (task.type) {
    case 'collect': return { kind: 'result', result: await member.collect() };
    case 'quote': return { kind: 'result', result: await member.quote(task.payload) };
    case 'checkout': return { kind: 'result', result: await member.checkout(task.payload) };
    case 'payment': return { kind: 'result', result: await member.syncPayment(task.payload) };
    case 'bill': {
      const bill = task.payload?.bill ?? task.payload;
      if (bill?.agent_id !== member.agent_id) fail('wrong_bill_recipient', '协调器账单不属于本机主人，未展示或确认送达。');
      const amount = bill?.payable_cents ?? bill?.amount_cents ?? bill?.due_cents;
      if (!Number.isSafeInteger(amount) || amount < 0) fail('invalid_bill', '协调器分账金额未经确认。');
      const detail = { ...ownBillDetails(bill, member.agent_id), amount_cents: amount, payment_state: 'transfer_not_executed' };
      for (const key of ['payer_agent_id', 'session_id']) if (typeof task.payload?.[key] === 'string') detail[key] = publicText(task.payload[key]);
      if (task.payload?.amount_to_transfer_cents !== undefined) {
        const transfer = task.payload.amount_to_transfer_cents;
        if (!Number.isSafeInteger(transfer) || transfer < 0 || (task.payload.payer_agent_id === member.agent_id && transfer !== 0) || (typeof task.payload.payer_agent_id === 'string' && task.payload.payer_agent_id !== member.agent_id && transfer !== amount)) fail('invalid_bill', '本人应转账金额未经确认。');
        detail.amount_to_transfer_cents = transfer;
      }
      process.stdout.write(`${JSON.stringify({ agent_id: member.agent_id, bill: detail })}\n`);
      return { kind: 'result', result: { agent_id: member.agent_id, status: 'bill_received', amount_cents: amount } };
    }
    case 'proposal': {
      const payload = task.payload;
      if (!payload || !/^[a-f0-9]{64}$/.test(payload.plan_hash ?? '') || typeof payload.owner_agent_id !== 'string' || payload.bill?.agent_id !== member.agent_id || !Number.isSafeInteger(payload.bill?.payable_cents) || payload.bill.payable_cents < 0) fail('invalid_proposal', '协调器方案与本人账单未经确认。');
      const selected = payload.selected_option;
      const summary = { agent_id: member.agent_id, proposal: { plan_hash: payload.plan_hash, owner_agent_id: publicText(payload.owner_agent_id), payable_cents: payload.bill.payable_cents,
        bill: ownBillDetails(payload.bill, member.agent_id), settlement_only: payload.settlement_only === true,
        selected_option: { id: publicText(selected?.id), label: publicText(selected?.label), items: (selected?.items ?? []).slice(0, 60).map(item => ({ sku: publicText(item.sku), name: publicText(item.name), quantity: item.quantity })) },
        coupon_replacements: (payload.coupon_replacements ?? []).slice(0, 8).map(binding => ({ agent_id: publicText(binding.agent_id), option_id: publicText(binding.option_id), item_index: binding.item_index, base_sku: publicText(binding.base_sku), product_sku: publicText(binding.product_sku), owner_confirmed: binding.owner_confirmed === true })),
        status: publicText(payload.status), expires_at: publicText(payload.expires_at), approval: '主人需在本机运行 approve；未自动批准',
        purpose_hint: payload.settlement_only === true ? '仅确认已支付订单分账，不授权再次创建；使用 approve --settlement-only' : '确认当前餐品及付款方案；使用 approve' } };
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return { kind: 'ack', result: { status: 'proposal_received' } };
    }
    default: fail('invalid_coordinator_task', '协调器请求了本机 Agent 未支持的任务。');
  }
}

export function taskSubmission(task, answer) {
  if (answer.kind === 'ack') return { route: '/api/agent/ack', body: { task_id: task.id } };
  if (answer.kind === 'error') return { route: '/api/agent/result', body: { task_id: task.id, error: answer.error } };
  return { route: '/api/agent/result', body: { task_id: task.id, result: answer.result } };
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') { process.stdout.write(`${HELP}\n实付差额仅确认分账：approve 命令加 --settlement-only，不授权再次创建订单。\n`); return; }
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') options.once = true;
    else if (arg === '--confirm-absent') options.confirmAbsent = true;
    else if (arg === '--settlement-only') options.settlementOnly = true;
    else if (['--profile', '--input', '--coordinator', '--plan-hash', '--reference', '--order-id', '--poll-ms'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_cli', '本机命令参数缺少值。');
      options[arg.slice(2)] = argv[++i];
    } else fail('invalid_cli', '本机命令包含未知参数。');
  }
  if (options.settlementOnly && command !== 'approve') fail('invalid_cli', '--settlement-only 仅用于主人确认已支付分账的 approve 命令。');
  if (!options.profile) fail('missing_profile', '请用 --profile 指定主人自己的本机设置。');
  const profile = await jsonFile(options.profile);
  const member = new MemberAgent({ token: process.env.MCD_MCP_TOKEN, profile });
  const agent_id = member.agent_id;
  const secret = process.env.TOGETHER_AGENT_SECRET;
  const request = (route, settings = {}) => coordinatorRequest(options.coordinator, route, { agent_id, secret, ...settings });
  if (command === 'collect') { const snapshot = await member.collect(); process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`); return snapshot; }
  if (command === 'quote') {
    if (!options.input) fail('invalid_cli', 'quote 需要 --input 任务 JSON。');
    const result = await member.quote(await jsonFile(options.input)); process.stdout.write(`${JSON.stringify(result)}\n`); return result;
  }
  if (command === 'payment') {
    if (!options.reference) fail('invalid_cli', 'payment 需要 --reference 本机订单引用。');
    const result = await member.localPaymentInfo(options.reference); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result;
  }
  if (command === 'reconcile') {
    if (!options.reference || (!options['order-id'] && !options.confirmAbsent)) fail('invalid_cli', 'reconcile 需要订单引用和 --order-id，或主人核实后的 --confirm-absent。');
    if (options['order-id'] && options.confirmAbsent) fail('invalid_cli', '核实实际订单和确认没有订单不能同时选择。');
    if (!process.stdin.isTTY) fail('owner_approval_required', '异常订单核实必须由主人在本机交互终端完成。');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await prompt.question(`${options.confirmAbsent ? '请先在本人麦当劳账号核实本次完全没有创建订单。' : '请核对这是本次异常创建的本人订单号。'}确认后再次粘贴本机引用 ${options.reference}：\n`); }
    finally { prompt.close(); }
    if (answer.trim() !== options.reference) fail('owner_approval_required', '未确认异常订单，防重记录保持不变。');
    const result = await member.reconcileLocal({ reference: options.reference, order_id: options['order-id'], confirmedAbsent: options.confirmAbsent === true, explicitOwnerApproval: true });
    process.stdout.write(`${JSON.stringify(result)}\n`); return result;
  }
  if (command === 'approve') {
    const planHash = options['plan-hash'];
    if (!/^[a-f0-9]{64}$/.test(planHash ?? '')) fail('invalid_plan_hash', 'approve 需要完整的当前方案 SHA256。');
    if (!process.stdin.isTTY) fail('owner_approval_required', '方案批准必须由主人在自己的交互终端完成；worker 不能自动批准。');
    coordinatorURL(options.coordinator);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await prompt.question(`${options.settlementOnly ? '仅确认已支付订单分账，不授权再次创建。请核对实付差额与本人 AA 明细。' : '请核对当前餐品、付款人和 AA 金额。'}确认方案 ${planHash}，请再次粘贴该哈希：\n`); }
    finally { prompt.close(); }
    if (answer.trim() !== planHash) fail('owner_approval_required', '未确认当前方案，未发送批准。');
    const local = await member.approveLocal(planHash, { explicitOwnerApproval: true, purpose: options.settlementOnly ? 'settlement' : 'checkout' });
    await request('/api/agent/approve', { body: { plan_hash: planHash } });
    process.stdout.write(`${JSON.stringify(local)}\n`); return local;
  }
  if (command !== 'worker') fail('invalid_cli', '请选择 collect、quote、worker、approve、payment 或 reconcile。');
  coordinatorURL(options.coordinator);
  const interval = Number(options['poll-ms'] ?? 3000);
  if (!Number.isInteger(interval) || interval < 1000 || interval > 30_000) fail('invalid_cli', '任务间隔需为 1000–30000 毫秒。');
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      const response = await request(`/api/agent/tasks?agent_id=${encodeURIComponent(agent_id)}`, { method: 'GET' });
      if (!Array.isArray(response.tasks) || response.tasks.length > 100) fail('invalid_coordinator_response', '协调器任务列表未经确认。');
      for (const task of response.tasks) {
        let answer;
        try { answer = await processTask(member, task); }
        catch (error) { answer = { kind: 'error', error: error instanceof McpError ? error.toJSON() : { code: 'local_task_failed', message: '本机任务未完成；详情已隐藏。' } }; }
        const submission = taskSubmission(task, answer);
        await request(submission.route, { body: submission.body });
      }
      if (!options.once && !stopped) await delay(interval);
    } while (!options.once && !stopped);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  const safe = error instanceof McpError ? error.toJSON() : { code: 'local_member_failed', message: '本机 Agent 未完成；文件及凭据详情已隐藏。' };
  process.stderr.write(`${JSON.stringify({ error: safe })}\n`); process.exitCode = 1;
});

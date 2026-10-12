import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemberAgent, yuanToCents } from '../src/member.mjs';
import { summarizeHistory } from '../src/history.mjs';
import { McpError } from '../src/mcp.mjs';
import { coordinatorURL, coordinatorRequest, processTask, taskSubmission } from '../scripts/member.mjs';

// Synthetic official-shape fixtures. No real user, Token, order or price is used.
const ok = data => ({ structuredContent: { success: true, code: 200, data } });
const planHash = 'a'.repeat(64);
const profile = () => ({ agent_id: 'alice', name: '小麦', context: { storeCode: 'store-demo', beCode: 'be-demo', orderType: 1, beType: 1 }, fulfillment_key: 'office-demo', takeWayCode: 'counter', budget_cents: 5000,
  history: { shared: true }, options: [{ id: 'burger', label: '汉堡', items: [{ sku: 'sku-burger', quantity: 1 }] }] });
const session = () => ({ id: 'room-demo', store_id: 'store-demo', service_mode: 'pickup', fulfillment_key: 'office-demo', participants: [
  { agent_id: 'alice', options: [{ id: 'burger', items: [{ sku: 'sku-burger', name: '巨无霸', quantity: 1 }] }] },
  { agent_id: 'bob', options: [{ id: 'fries', items: [{ sku: 'sku-fries', name: '中薯条', quantity: 1 }] }] },
] });
const candidate = () => ({ owner_agent_id: 'alice', option_ids: { alice: 'burger', bob: 'fries' }, coupon_ids: [], benefit_ids: [], total_cents: 2000, delivery_cents: 0 });
const properties = names => Object.fromEntries(names.map(name => [name, { type: name === 'items' ? 'array' : name === 'needTableware' ? 'boolean' : ['orderType', 'beType'].includes(name) ? 'integer' : 'string' }]));
const schemas = [
  ['order-list', []], ['query-order', ['orderId']], ['query-my-coupons', []], ['query-my-account', []],
  ['query-store-coupons', ['storeCode', 'beCode', 'orderType', 'beType', 'reservationDate']], ['query-meals', ['storeCode', 'beCode', 'orderType', 'beType', 'reservationDate']],
  ['query-meal-detail', ['code', 'storeCode', 'beCode', 'orderType', 'beType']],
  ['calculate-price', ['storeCode', 'beCode', 'orderType', 'beType', 'reservationDate', 'needTableware', 'items']], ['create-order', ['storeCode', 'beCode', 'beType', 'addressId', 'takeWayCode', 'needTableware', 'items']],
].map(([name, fields]) => ({ name, inputSchema: { type: 'object', properties: properties(fields), additionalProperties: false } }));

async function fixture(t, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'together-member-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'private', 'member.json');
  const calls = [];
  let total = settings.total ?? 2000, status = '待支付';
  const client = { async listTools() { return schemas; }, async callTool(name, args, flags) {
    calls.push({ name, args, flags });
    if (settings.handle) { const value = await settings.handle(name, args, flags); if (value !== undefined) return value; }
    switch (name) {
      case 'order-list': return ok({ list: [
        { orderId: 'private-history-order', orderStatus: '订单已完成', storeName: 'private-store', phone: '13812345678', orderProductList: [{ productName: '巨无霸', productCode: 'old-code', quantity: 1 }] },
        { orderId: 'private-cancelled-order', orderStatus: '订单已取消', orderProductList: [{ productName: '中薯条', quantity: 1 }] },
      ] });
      case 'query-my-coupons': return { content: [{ type: 'text', text: '# 我的优惠券\n私人账户摘要：不可转发。' }] };
      case 'query-my-account': return ok({ availablePoint: '1234', phone: '13812345678' });
      case 'query-store-coupons': return ok([{ title: '汉堡优惠', couponId: 'private-coupon-id', couponCode: 'private-coupon-code', tradeDateTime: 'demo-range', products: [{ productCode: 'coupon-burger', productName: '巨无霸' }] }]);
      case 'query-meals': return ok({ meals: { 'sku-burger': { name: '巨无霸', currentPrice: '15.00', originalPrice: '16.00', discountType: '麦金卡优惠' }, 'sku-fries': { name: '中薯条', currentPrice: '5.00', originalPrice: '5.00', discountType: null } } });
      case 'query-meal-detail': return ok({ code: args.code, rounds: [], supportModify: true, modification: { items: [{ values: [{ code: '100160', minQuantity: 0, maxQuantity: 1, selectedQuantity: 1, selectedKey: '0-1', unselectedKey: '0-0' }] }] } });
      case 'calculate-price': return ok({ price: total, deliveryPrice: 0, productPrice: total, productList: args.items.map(item => ({ productCode: item.productCode, productName: '虚构餐品', quantity: item.quantity, originalSubtotal: 1000, subtotal: 1000 })), takeWayList: [{ code: 'counter', name: '柜台' }], tablewarePrice: 0 });
      case 'create-order': return ok({ orderId: 'private-created-order', payId: 'private-pay-id', payH5Url: 'https://m.mcd.cn/payment?orderId=private-created-order', orderDetail: { orderStatus: '待支付', realTotalAmount: '20.00' } });
      case 'query-order': return ok({ orderId: 'private-created-order', orderStatus: status, realTotalAmount: '20.00', realDeliveryPrice: '0.00', mobilePhone: '13812345678', orderProductList: [] });
      default: throw new Error('unexpected synthetic tool');
    }
  } };
  const make = (p = profile()) => new MemberAgent({ token: 'synthetic-local-only', profile: p, client, ledgerPath: ledger });
  return { member: make(settings.profile ?? profile()), make, client, calls, ledger, setPrice(value) { total = value; }, setStatus(value) { status = value; } };
}
function checkoutPayload(c = candidate()) {
  return { candidate_id: 'candidate-demo', candidate: c, session: { ...session(), plan_hash: planHash }, plan_hash: planHash,
    approval_receipts: ['alice', 'bob'].map(agent_id => ({ agent_id, plan_hash: planHash, approved: true })) };
}
async function prepared(t, settings) {
  const f = await fixture(t, settings);
  await f.member.collect();
  await f.member.quote({ candidate_id: 'candidate-demo', candidate: candidate(), session: session() });
  await f.member.approveLocal(planHash, { explicitOwnerApproval: true });
  return f;
}

test('history shares only allowed completed frequency facts, not historical codes or personal fields', () => {
  const rows = [
    { orderStatus: '订单已完成', orderId: 'secret-id', storeName: 'private-store', orderProductList: [{ productName: '三件套餐', quantity: 1, productCode: 'old-parent', comboItemList: [{ name: '巨无霸_1234', quantity: 2, productCode: 'old-leaf' }, { name: '中薯条', quantity: 1 }] }, { productName: '巨无霸', quantity: 1 }] },
    { orderStatus: '待支付', orderProductList: [{ productName: '巨无霸', quantity: 1 }] },
    { orderStatus: 30, orderProductList: [{ productName: '巨无霸', quantity: 1 }] },
  ];
  const summary = summarizeHistory(rows, { shared: true });
  assert.equal(summary.sample_size, 1); assert.equal(summary.excluded_count, 2);
  assert.equal(summary.foods.find(food => food.name === '巨无霸').order_count, 1);
  assert.doesNotMatch(JSON.stringify(summary), /secret-id|private-store|old-parent|old-leaf|productCode/);
  assert.deepEqual(summarizeHistory(rows), { shared: false, source: 'withheld', scope: '主人未授权分享近期点餐摘要', foods: [] });
});

test('collect reads each account locally and returns opaque coupons and unknown benefit summaries', async t => {
  const f = await fixture(t);
  const snapshot = await f.member.collect();
  assert.deepEqual(f.calls.map(call => call.name), ['order-list', 'query-my-coupons', 'query-my-account', 'query-store-coupons', 'query-meals']);
  assert.equal(snapshot.agent_id, 'alice'); assert.equal(snapshot.options[0].price_cents, 1500);
  assert.equal(snapshot.account.coupons[0].known, false); assert.match(snapshot.account.coupons[0].id, /^coupon-/);
  assert.equal(snapshot.account.benefits[0].known, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|synthetic-local-only|13812345678|availablePoint|old-code|couponCode|couponId/);
  assert.equal((await stat(f.ledger)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.ledger, '..'))).mode & 0o777, 0o700);
});

test('a withheld history setting never leaks even counts and historical SKUs cannot substitute menu codes', async t => {
  const p = profile(); p.history.shared = false;
  const f = await fixture(t, { profile: p });
  const snapshot = await f.member.collect();
  assert.equal(snapshot.history.shared, false); assert.equal(snapshot.history.sample_size, undefined);
  p.options[0].items[0].sku = 'old-code';
  await assert.rejects(f.make(p).collect(), { code: 'current_sku_unavailable' });
});

test('sidecar quotes the full chosen basket using its own current context and returns no account secrets', async t => {
  const f = await fixture(t); await f.member.collect();
  const result = await f.member.quote({ candidate_id: 'candidate-demo', candidate: candidate(), session: session() });
  const call = f.calls.find(call => call.name === 'calculate-price');
  assert.deepEqual(call.args.items, [{ productCode: 'sku-burger', quantity: 1 }, { productCode: 'sku-fries', quantity: 1 }]);
  assert.equal(call.args.storeCode, 'store-demo'); assert.equal(result.total_cents, 2000); assert.equal(result.verified, true);
  assert.doesNotMatch(JSON.stringify(result), /private-|couponCode|couponId|payment|synthetic/);
  const changed = session(); changed.store_id = 'other-store';
  await assert.rejects(f.member.quote(candidate(), changed), { code: 'context_mismatch' });
});

test('coupon use needs an explicit local single-item mapping; only that owner line gets raw coupon identifiers', async t => {
  const p = profile(); p.coupon_bindings = { 'private-coupon-id': { agent_id: 'alice', option_id: 'burger', item_index: 0, base_productCode: 'sku-burger', productCode: 'coupon-burger', replacement_confirmed: true } };
  const f = await fixture(t, { profile: p }); const snapshot = await f.member.collect();
  const c = candidate(); c.coupon_ids = [snapshot.account.coupons[0].id];
  assert.equal(snapshot.account.coupons[0].quote_only, true);
  assert.deepEqual(snapshot.account.coupons[0].binding_summary, { agent_id: 'alice', option_id: 'burger', item_index: 0, base_sku: 'sku-burger', product_sku: 'coupon-burger', owner_confirmed: true });
  await f.member.quote(c, session());
  const args = f.calls.find(call => call.name === 'calculate-price').args;
  assert.equal(args.items[0].couponId, 'private-coupon-id'); assert.equal(args.items[0].couponCode, 'private-coupon-code'); assert.equal(args.items[0].productCode, 'coupon-burger');
  assert.equal(args.items[1].couponId, undefined);
  const withoutMapping = await fixture(t); const s2 = await withoutMapping.member.collect(); c.coupon_ids = [s2.account.coupons[0].id];
  await assert.rejects(withoutMapping.member.quote(c, session()), { code: 'coupon_binding_unconfirmed' });
});

test('unconfirmed price units, unknown scopes and changed owner choices fail closed', async t => {
  assert.equal(yuanToCents('12.34'), 1234); assert.throws(() => yuanToCents('12.345'), { code: 'unsupported_price_unit' });
  const f = await fixture(t, { handle(name) { if (name === 'calculate-price') return ok({ price: '20.00', deliveryPrice: 0, productPrice: 2000, productList: [] }); } });
  await f.member.collect();
  await assert.rejects(f.member.quote(candidate(), session()), { code: 'unsupported_price_schema' });
  const s = session(); s.participants[0].options[0].items[0].quantity = 2;
  await assert.rejects(f.member.quote(candidate(), s), { code: 'owner_choice_changed' });
});

test('checkout requires current local owner approval plus every member receipt', async t => {
  const f = await fixture(t); await f.member.collect(); await f.member.quote({ candidate_id: 'candidate-demo', candidate: candidate(), session: session() });
  await assert.rejects(f.member.checkout(checkoutPayload()), { code: 'owner_approval_required' });
  await assert.rejects(f.member.approveLocal(planHash), { code: 'owner_approval_required' });
  await f.member.approveLocal(planHash, { explicitOwnerApproval: true });
  const payload = checkoutPayload(); payload.approval_receipts.pop();
  await assert.rejects(f.member.checkout(payload), { code: 'member_approval_required' });
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 0);
});

test('reprice drift revokes approval and never creates an order', async t => {
  const f = await prepared(t); f.setPrice(2100);
  const result = await f.member.checkout(checkoutPayload());
  assert.equal(result.status, 'PRICE_CHANGED'); assert.equal(result.total_cents, 2100);
  await assert.rejects(f.member.checkout(checkoutPayload()), { code: 'owner_approval_required' });
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 0);
});

test('creation is one-shot across restarts, payment links stay local, creation is not payment', async t => {
  const f = await prepared(t);
  const result = await f.member.checkout(checkoutPayload());
  assert.equal(result.status, 'awaiting_payment'); assert.doesNotMatch(JSON.stringify(result), /private-created|payH5Url|payment_url/);
  const call = f.calls.find(call => call.name === 'create-order');
  assert.equal(call.flags.mutationAuthorized, true); assert.equal(call.args.takeWayCode, 'counter'); assert.equal(call.args.orderType, undefined);
  const restarted = f.make(); assert.deepEqual(await restarted.checkout(checkoutPayload()), result);
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 1);
  assert.match((await restarted.localPaymentInfo(result.order_reference)).payment_url, /^https:/);
  f.setStatus('制作中'); assert.equal((await restarted.syncPayment(result)).status, 'payment_unconfirmed');
  f.setStatus('订单已完成'); const paid = await restarted.syncPayment(result); assert.equal(paid.status, 'completed'); assert.equal(paid.paid, true); assert.equal(paid.delivery_cents, 0);
  assert.doesNotMatch(JSON.stringify(await restarted.syncPayment(result)), /private-created|13812345678/);
});

test('an uncertain mutation result is fenced durably and never retried', async t => {
  const f = await prepared(t, { handle(name) { if (name === 'create-order') throw new McpError('timeout', 'secret-upstream'); } });
  const first = await f.member.checkout(checkoutPayload());
  assert.equal(first.status, 'outcome_unknown');
  const state = JSON.parse(await readFile(f.ledger, 'utf8')); assert.equal(state.orders[planHash].status, 'outcome_unknown');
  assert.deepEqual(await f.make().checkout(checkoutPayload()), first);
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 1);
});

test('parallel local processes cannot both create for the same plan', async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = await prepared(t, { async handle(name) { if (name === 'create-order') { await gate; return ok({ orderId: 'private-created-order', payH5Url: 'https://m.mcd.cn/payment', orderDetail: { orderStatus: '待支付' } }); } } });
  const first = f.member.checkout(checkoutPayload());
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(f.make().checkout(checkoutPayload()), { code: 'local_operation_in_progress' });
  finish(); await first;
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 1);
});

test('coordinator channel uses a separate credential, rejects unsafe endpoints and never posts MCP Token', async () => {
  assert.equal(coordinatorURL('https://room.example'), 'https://room.example');
  assert.throws(() => coordinatorURL('http://public.example'), { code: 'invalid_coordinator' });
  assert.throws(() => coordinatorURL('https://secret@room.example'), { code: 'invalid_coordinator' });
  let request;
  await coordinatorRequest('https://room.example', '/api/agent/snapshot', { agent_id: 'alice', secret: 'synthetic-room-key', body: { snapshot: { agent_id: 'alice', options: [] } }, fetchImpl: async (url, settings) => { request = { url: String(url), settings }; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  assert.equal(request.settings.headers.Authorization, 'Bearer synthetic-room-key');
  assert.equal(request.settings.redirect, 'error'); assert.equal(JSON.parse(request.settings.body).agent_id, 'alice');
  assert.doesNotMatch(request.settings.body, /MCD_MCP_TOKEN|synthetic-local-only/);
});

test('collect task completes through result wire and failures use top-level error', async () => {
  const task = { id: 'task-collect', type: 'collect', payload: {} };
  const answer = await processTask({ agent_id: 'alice', async collect() { return { agent_id: 'alice', options: [] }; } }, task);
  assert.deepEqual(taskSubmission(task, answer), { route: '/api/agent/result', body: { task_id: 'task-collect', result: { agent_id: 'alice', options: [] } } });
  assert.deepEqual(taskSubmission(task, { kind: 'error', error: { code: 'missing_token', message: '本机未连接' } }), { route: '/api/agent/result', body: { task_id: 'task-collect', error: { code: 'missing_token', message: '本机未连接' } } });
});

test('proposal displays only the member choice and bill, never approves; formal bill uses payable_cents', async () => {
  const output = [];
  const original = process.stdout.write;
  process.stdout.write = function (text) { output.push(String(text)); return true; };
  try {
    const task = { id: 'task-proposal', type: 'proposal', payload: { plan_hash: planHash, owner_agent_id: 'bob', selected_option: { id: 'burger', label: '巨无霸', items: [{ sku: 'sku-burger', name: '巨无霸', quantity: 1, phone: '13812345678' }] }, bill: { agent_id: 'alice', payable_cents: 1501, private_token: 'not-forwarded' }, status: 'verified', expires_at: '2099-01-01T00:00:00Z', coupon_replacements: [] } };
    const answer = await processTask({ agent_id: 'alice' }, task);
    assert.deepEqual(taskSubmission(task, answer), { route: '/api/agent/ack', body: { task_id: 'task-proposal' } });
    const proposal = JSON.parse(output[0]); assert.equal(proposal.proposal.payable_cents, 1501); assert.match(proposal.proposal.approval, /未自动批准/);
    assert.doesNotMatch(output[0], /not-forwarded|13812345678|private_token/);
    const bill = await processTask({ agent_id: 'alice' }, { id: 'task-bill', type: 'bill', payload: { bill: { agent_id: 'alice', payable_cents: 1501 }, amount_to_transfer_cents: 1501 } });
    assert.equal(bill.result.amount_cents, 1501);
  } finally { process.stdout.write = original; }
});

test('coupon replacement is never inferred and raw coupon pool can exceed public selection limits', async t => {
  const p = profile(); p.selected_coupon_ids = ['private-coupon-2'];
  const f = await fixture(t, { profile: p, handle(name) { if (name === 'query-store-coupons') return ok(Array.from({ length: 20 }, (_, i) => ({ title: '虚构券', couponId: `private-coupon-${i}`, couponCode: `private-code-${i}`, products: [{ productCode: 'coupon-burger', productName: '巨无霸' }] }))); } });
  const snapshot = await f.member.collect();
  assert.equal(snapshot.account.coupons.length, 1); assert.equal(snapshot.account.coupon_selection_note.available_count, 20); assert.equal(snapshot.account.coupon_selection_note.complete, false);
  const state = JSON.parse(await readFile(f.ledger, 'utf8')); assert.equal(Object.keys(state.coupons).length, 20);
  const p2 = profile(); p2.coupon_bindings = { 'private-coupon-id': { agent_id: 'alice', option_id: 'burger', item_index: 0, base_productCode: 'sku-burger', productCode: 'coupon-burger' } };
  const f2 = await fixture(t, { profile: p2 }); const s2 = await f2.member.collect();
  assert.equal(s2.account.coupons[0].quote_only, undefined);
  const c = candidate(); c.coupon_ids = [s2.account.coupons[0].id];
  await assert.rejects(f2.member.quote(c, session()), { code: 'coupon_binding_unconfirmed' });
});

test('declared paid or points rules retain their disqualifying fields and cannot silently enable quote_only', async t => {
  const p = profile();
  p.coupon_rules = { 'private-coupon-id': { known: true, type: 'fixed', name: '积分券', expires_at: '2099-01-01T00:00:00Z', valid_from: '2020-01-01T00:00:00Z', store_ids: '*', service_modes: '*', fulfillment_keys: '*', eligible_skus: '*', amount_cents: 100, cash_cost_cents: 50, uses_points: true, min_quantity: 1 } };
  const f = await fixture(t, { profile: p }); const snapshot = await f.member.collect();
  const rule = snapshot.account.coupons[0];
  assert.equal(rule.cash_cost_cents, 50); assert.equal(rule.uses_points, true); assert.equal(rule.min_quantity, 1); assert.equal(rule.valid_from, '2020-01-01T00:00:00Z'); assert.equal(rule.quote_only, undefined);
});

test('custom modifications require current detail fields; unknown combo rounds are refused', async t => {
  const p = profile(); p.options[0].price_cents = 1500; p.options[0].items[0].modification = { values: [{ code: '100160', quantity: 0, key: '0-0' }] };
  const f = await fixture(t, { profile: p }); const snapshot = await f.member.collect();
  assert.deepEqual(snapshot.options[0].items[0].modification, p.options[0].items[0].modification);
  assert.equal(f.calls.some(call => call.name === 'query-meal-detail'), true);
  const p2 = profile(); p2.options[0].price_cents = 1500; p2.options[0].items[0].roundList = [{ round: 1, comboItemList: [{ code: 'sku-fries', quantity: 1 }] }];
  await assert.rejects(f.make(p2).collect(), { code: 'configuration_unconfirmed' });
});

test('missing budget and another member bill fail without presenting an approval or amount', async t => {
  const p = profile(); delete p.budget_cents;
  const f = await fixture(t, { profile: p });
  await assert.rejects(f.member.collect(), { code: 'missing_owner_budget' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(processTask({ agent_id: 'alice' }, { id: 'task-bill', type: 'bill', payload: { bill: { agent_id: 'bob', payable_cents: 1000 } } }), { code: 'wrong_bill_recipient' });
  await assert.rejects(processTask({ agent_id: 'alice' }, { id: 'task-proposal', type: 'proposal', payload: { plan_hash: planHash, owner_agent_id: 'bob', bill: { agent_id: 'bob', payable_cents: 1000 } } }), { code: 'invalid_proposal' });
});

test('a hard owner limit is never discarded or relaxed', async t => {
  const p = profile(); p.max_pay_cents = 1;
  const f = await fixture(t, { profile: p });
  assert.equal((await f.member.collect()).max_pay_cents, 1);
  p.max_pay_cents = -1; assert.throws(() => f.make(p), { code: 'invalid_owner_limit' });
  p.max_pay_cents = '100'; assert.throws(() => f.make(p), { code: 'invalid_owner_limit' });
});

test('changing plan hash or room cannot evade an unresolved same-session or same-cart creation fence', async t => {
  const f = await prepared(t, { handle(name) { if (name === 'create-order') throw new McpError('timeout', 'synthetic uncertain create'); } });
  const prior = await f.member.checkout(checkoutPayload()); assert.equal(prior.status, 'outcome_unknown');
  const nextHash = 'b'.repeat(64);
  await f.member.quote({ candidate_id: 'candidate-next', candidate: candidate(), session: session() });
  await f.member.approveLocal(nextHash, { explicitOwnerApproval: true });
  const changed = { ...checkoutPayload(), candidate_id: 'candidate-next', plan_hash: nextHash, session: { ...session(), plan_hash: nextHash }, approval_receipts: ['alice', 'bob'].map(agent_id => ({ agent_id, plan_hash: nextHash, approved: true })) };
  await assert.rejects(f.make().checkout(changed), { code: 'unresolved_prior_order' });
  const newRoom = { ...session(), id: 'another-room' };
  await f.member.quote({ candidate_id: 'candidate-restarted', candidate: candidate(), session: newRoom });
  await assert.rejects(f.make().checkout({ ...changed, candidate_id: 'candidate-restarted', session: { ...newRoom, plan_hash: nextHash } }), { code: 'unresolved_prior_order' });
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 1);
  const state = JSON.parse(await readFile(f.ledger, 'utf8'));
  assert.equal(state.orders[planHash].session_id, 'room-demo'); assert.match(state.orders[planHash].cart_hash, /^[a-f0-9]{64}$/);
});

test('awaiting payment remains fenced, but confirmed cancellation permits a newly approved order', async t => {
  const f = await prepared(t); const prior = await f.member.checkout(checkoutPayload());
  const nextHash = 'c'.repeat(64), nextSession = { ...session(), id: 'next-room' };
  await f.member.quote({ candidate_id: 'next-order', candidate: candidate(), session: nextSession });
  await f.member.approveLocal(nextHash, { explicitOwnerApproval: true });
  const payload = { ...checkoutPayload(), candidate_id: 'next-order', plan_hash: nextHash, session: { ...nextSession, plan_hash: nextHash }, approval_receipts: ['alice', 'bob'].map(agent_id => ({ agent_id, plan_hash: nextHash, approved: true })) };
  await assert.rejects(f.member.checkout(payload), { code: 'unresolved_prior_order' });
  f.setStatus('订单已取消'); assert.equal((await f.member.syncPayment(prior)).status, 'cancelled');
  assert.equal((await f.member.checkout(payload)).status, 'awaiting_payment');
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 2);
});

test('unknown outcomes require explicit local owner review, preserve the audit trail, and cannot be rebound', async t => {
  const f = await prepared(t, { handle(name) { if (name === 'create-order') throw new McpError('timeout', 'synthetic uncertain create'); } });
  const unknown = await f.member.checkout(checkoutPayload());
  await assert.rejects(f.member.reconcileLocal({ reference: unknown.reference, confirmedAbsent: true }), { code: 'owner_approval_required' });
  const reviewed = await f.member.reconcileLocal({ reference: unknown.reference, confirmedAbsent: true, explicitOwnerApproval: true });
  assert.equal(reviewed.status, 'owner_confirmed_not_created'); assert.equal(reviewed.paid, false);
  const state = JSON.parse(await readFile(f.ledger, 'utf8')); assert.equal(state.orders[planHash].local_review_source, 'explicit_owner_account_check');
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 1);
  const actual = await prepared(t); const pending = await actual.member.checkout(checkoutPayload());
  await assert.rejects(actual.member.reconcileLocal({ reference: pending.reference, confirmedAbsent: true, explicitOwnerApproval: true }), { code: 'absence_unconfirmed' });
  await assert.rejects(actual.member.reconcileLocal({ reference: pending.reference, order_id: 'wrong-other-order', explicitOwnerApproval: true }), { code: 'order_reference_mismatch' });
});

test('a partial server basket is not a verified quote and additional card purchases cannot enter tool_args', async t => {
  const f = await fixture(t, { handle(name) { if (name === 'calculate-price') return ok({ price: 1500, deliveryPrice: 0, productPrice: 1500, productList: [{ productCode: 'sku-burger', quantity: 1, subtotal: 1500, originalSubtotal: 1500 }] }); } });
  await f.member.collect();
  await assert.rejects(f.member.quote(candidate(), session()), { code: 'quote_cart_mismatch' });
  const p = profile(); p.tool_args = { 'calculate-price': { withOrder: { membershipCode: '106' } } };
  await f.make(p).collect();
  await assert.rejects(f.make(p).quote(candidate(), session()), { code: 'additional_purchase_not_supported' });
});

test('settlement approval cannot authorize another creation even with the same fresh live quote', async t => {
  const f = await prepared(t);
  const approval = await f.member.approveLocal(planHash, { explicitOwnerApproval: true, purpose: 'settlement' });
  assert.equal(approval.purpose, 'settlement');
  const saved = JSON.parse(await readFile(f.ledger, 'utf8')); assert.equal(saved.approval.purpose, 'settlement');
  await assert.rejects(f.member.checkout(checkoutPayload()), { code: 'owner_approval_required' });
  assert.equal(f.calls.filter(call => call.name === 'create-order').length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { optimizeSession, enumerateCandidates, allocateBills } from '../src/optimizer.mjs';
import { allocateCents, splitParticipantBills } from '../src/money.mjs';

const office = JSON.parse(await readFile(new URL('../examples/office.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const at = '2026-10-12T03:30:00Z';
const context = { store_id: 'store', service_mode: 'delivery', fulfillment_key: 'lunch' };
const account = (coupons = [], benefits = [], fee = 0) => ({ eligible_to_order: true, coupons, benefits, delivery_fee_cents: fee, context: { ...context }, snapshot_at: '2026-10-12T03:29:00Z', expires_at: '2026-10-12T03:40:00Z' });
const rule = (id, fields = {}) => ({ id, type: 'fixed', known: true, amount_cents: 100, expires_at: '2026-10-12T23:59:00Z', store_ids: ['store'], service_modes: ['delivery'], fulfillment_keys: ['lunch'], eligible_skus: '*', available_count: 1, ...fields });
const option = (id, price, sku = id, quantity = 1) => ({ id, label: id, items: [{ sku, name: sku, quantity }], price_cents: price });
const participant = (id, options, coupons = [], benefits = [], fee = 0) => ({ agent_id: id, name: id, budget_cents: 10000, options, account: account(coupons, benefits, fee) });
const session = participants => ({ id: 'test-session', ...context, at, split_policy: 'proportional', participants });
const conserved = candidate => {
  assert.equal(candidate.participant_bills.reduce((sum, bill) => sum + bill.payable_cents, 0), candidate.total_cents);
  assert.equal(candidate.participant_bills.reduce((sum, bill) => sum + bill.food_cents, 0), candidate.food_cents);
  assert.equal(candidate.participant_bills.reduce((sum, bill) => sum + bill.discount_cents, 0), candidate.discount_cents);
  assert.equal(candidate.participant_bills.reduce((sum, bill) => sum + bill.delivery_cents, 0), candidate.delivery_cents);
  for (const bill of candidate.participant_bills) {
    for (const key of ['food_cents', 'discount_cents', 'delivery_cents', 'payable_cents']) assert.ok(Number.isSafeInteger(bill[key]) && bill[key] >= 0);
    assert.equal(bill.food_cents - bill.discount_cents + bill.delivery_cents, bill.payable_cents);
  }
};

test('fictional office optimum belongs to another account, with a real solo-choice baseline', () => {
  const result = optimizeSession(office);
  assert.equal(office.data_kind, 'fictional');
  assert.equal(result.best.owner_agent_id, 'bob');
  assert.notEqual(result.best.owner_agent_id, office.initiator_agent_id);
  assert.equal(result.best.food_cents, 8520);
  assert.equal(result.best.discount_cents, 1800);
  assert.equal(result.best.delivery_cents, 0);
  assert.equal(result.best.total_cents, 6720);
  assert.equal(result.solo_baseline.total_cents, 10232);
  assert.equal(result.savings_cents, 3512);
  assert.deepEqual(result.best.participant_bills.map(bill => bill.payable_cents), [1459, 1491, 2043, 1727]);
  assert.equal(result.status, 'estimate');
  assert.equal(result.audit.combinations_evaluated, 154);
  conserved(result.best);
});

test('another account cannot borrow the winning owners coupon', () => {
  const data = session([
    participant('a', [option('a-food', 500)], [rule('a-voucher', { amount_cents: 1000 })]),
    participant('b', [option('b-food', 500)], [rule('b-voucher', { amount_cents: 200 })]),
  ]);
  const result = optimizeSession(data);
  assert.equal(result.best.owner_agent_id, 'a');
  const b = result.account_candidates.find(candidate => candidate.owner_agent_id === 'b').best;
  assert.equal(b.total_cents, 800);
  assert.deepEqual(b.coupon_ids, ['b-voucher']);
  assert.ok(!b.coupon_ids.includes('a-voucher'));
});

test('a more expensive allowed configuration can unlock the exact better group solution', () => {
  const data = session([
    participant('a', [option('a-small', 950), option('a-large', 1000)], [rule('threshold', { amount_cents: 500, min_food_cents: 2000 })]),
    participant('b', [option('b-small', 950), option('b-large', 1000)]),
  ]);
  const result = optimizeSession(data);
  assert.deepEqual(result.best.option_ids, { a: 'a-large', b: 'b-large' });
  assert.equal(result.best.total_cents, 1500);
  assert.equal(result.solo_baseline.total_cents, 1900);
});

test('same-group vouchers remain exclusive even when both say stackable', () => {
  const data = session([participant('a', [option('meal', 1000)], [
    rule('one', { amount_cents: 100, stackable: true, group: 'meal-voucher' }),
    rule('two', { amount_cents: 200, stackable: true, group: 'meal-voucher' }),
  ])]);
  assert.equal(optimizeSession(data).best.total_cents, 800);
  assert.ok(enumerateCandidates(data).every(candidate => candidate.coupon_ids.length <= 1));
});

test('unmarked stacking is refused; explicitly marked percentage and fixed can combine', () => {
  const data = session([participant('a', [option('meal', 1000)], [
    rule('fixed', { amount_cents: 100 }),
    rule('percent', { type: 'percent', discount_bps: 1000, stackable: true }),
  ])]);
  assert.equal(optimizeSession(data).best.total_cents, 900);
  data.participants[0].account.coupons[0].stackable = true;
  assert.equal(optimizeSession(data).best.total_cents, 800);
});

test('expiry, mode, store, SKU and inventory limits prevent inapplicable savings', () => {
  const data = session([participant('a', [option('meal', 1000)], [
    rule('expired', { expires_at: at }), rule('wrong-store', { store_ids: ['other'] }),
    rule('wrong-mode', { service_modes: ['pickup'] }), rule('wrong-sku', { eligible_skus: ['other'] }),
    rule('gone', { available_count: 0 }),
  ])]);
  const result = optimizeSession(data);
  assert.equal(result.best.total_cents, 1000);
  assert.deepEqual(result.best.coupon_ids, []);
  assert.ok(result.audit.ignored_rules.some(entry => entry.rule_id === 'expired'));
  assert.ok(result.best.audit.ignored_rules.some(entry => entry.rule_id === 'wrong-sku'));
});

test('points, unknown types and incomplete rule scopes are not treated as cash', () => {
  const data = session([participant('a', [option('meal', 1000)], [
    rule('points', { points_cost: 50, amount_cents: 1000 }),
    rule('unknown', { type: 'mystery', amount_cents: 1000 }),
    rule('unconfirmed', { known: false, amount_cents: 1000 }),
    rule('missing-scope', { eligible_skus: undefined, amount_cents: 1000 }),
  ])]);
  const result = optimizeSession(data);
  assert.equal(result.best.total_cents, 1000);
  assert.equal(result.audit.ignored_rules.length, 4);
});

test('item-specific fixed discount is bounded by matching quantities and actual unit prices', () => {
  const data = session([
    participant('a', [option('three-a', 600, 'sku-a', 3)], [rule('two-only', { type: 'item_fixed', amount_cents: 150, eligible_skus: ['sku-a'], max_quantity: 2 })]),
    participant('b', [option('one-b', 300, 'sku-b')]),
  ]);
  const result = optimizeSession(data);
  assert.equal(result.best.discount_cents, 300);
  assert.equal(result.best.total_cents, 600);
  conserved(result.best);
});

test('unknown bundle component prices do not invent targeted discounts', () => {
  const bundle = { id: 'bundle', label: 'bundle', price_cents: 1000, items: [{ sku: 'one', name: 'one', quantity: 1 }, { sku: 'two', name: 'two', quantity: 1 }] };
  const data = session([participant('a', [bundle], [rule('targeted', { type: 'item_fixed', eligible_skus: ['one'], amount_cents: 500 })])]);
  const result = optimizeSession(data);
  assert.equal(result.best.discount_cents, 0);
  assert.ok(result.audit.ignored_rules.some(entry => entry.reason === 'target_item_price_unknown'));
  bundle.items[0].unit_price_cents = 400;
  bundle.items[1].unit_price_cents = 600;
  assert.equal(optimizeSession(data).best.discount_cents, 400);
});

test('gold case rejects a flexible limited voucher overlapping a specific voucher rather than falsely declaring a greedy optimum', () => {
  const basket = { id: 'both', label: 'both', price_cents: 300, items: [
    { sku: 'high', name: 'high', quantity: 1, unit_price_cents: 200 },
    { sku: 'low', name: 'low', quantity: 1, unit_price_cents: 100 },
  ] };
  const flexible = rule('a-flexible', { type: 'item_fixed', amount_cents: 150, max_quantity: 1, eligible_skus: ['high', 'low'], stackable: true });
  const specific = rule('b-specific', { type: 'item_fixed', amount_cents: 200, max_quantity: 1, eligible_skus: ['high'], stackable: true });
  const data = session([participant('a', [basket], [flexible, specific])]);
  assert.throws(() => optimizeSession(data), error => error.code === 'AMBIGUOUS_RULE_BINDING' && error.details.exact === false);
  assert.throws(() => enumerateCandidates(data), { code: 'AMBIGUOUS_RULE_BINDING' });
  // The owner explicitly confines the first voucher to the other SKU.
  flexible.eligible_skus = ['low'];
  const resolved = optimizeSession(data);
  assert.equal(resolved.best.total_cents, 0);
  assert.deepEqual(resolved.best.coupon_ids, ['a-flexible', 'b-specific']);
  conserved(resolved.best);
});

test('overlapping scoped fixed-credit attribution is rejected when it can change a later item discount', () => {
  const basket = { id: 'both', label: 'both', price_cents: 300, items: [
    { sku: 'high', name: 'high', quantity: 1, unit_price_cents: 200 },
    { sku: 'low', name: 'low', quantity: 1, unit_price_cents: 100 },
  ] };
  const data = session([participant('a', [basket], [
    rule('a-general', { amount_cents: 150, eligible_skus: '*', stackable: true }),
    rule('b-targeted', { amount_cents: 200, eligible_skus: ['high'], stackable: true }),
  ])]);
  assert.throws(() => optimizeSession(data), { code: 'AMBIGUOUS_RULE_BINDING' });
});

test('canonical order-wide percentage followed by a fixed credit stays exact in its declared arithmetic model', () => {
  const data = session([participant('a', [option('meal', 999)], [
    rule('percent', { type: 'percent', discount_bps: 1000, stackable: true }),
    rule('fixed', { amount_cents: 100, stackable: true }),
  ])]);
  const result = optimizeSession(data);
  assert.equal(result.best.discount_cents, 199);
  assert.equal(result.best.total_cents, 800);
  assert.equal(result.exact, true);
});

test('basis-point discount floors in integer cents, with zero payable still supported', () => {
  const data = session([participant('a', [option('meal', 999)], [rule('percent', { type: 'percent', discount_bps: 1500 })])]);
  assert.equal(optimizeSession(data).best.discount_cents, 149);
  data.participants[0].account.coupons[0].discount_bps = 10000;
  const result = optimizeSession(data);
  assert.equal(result.best.total_cents, 0);
  conserved(result.best);
});

test('Hamilton allocation is conservative and tied remainders are stable by agent ID', () => {
  assert.deepEqual(allocateCents(2, [1, 1, 1], ['c', 'a', 'b']), [0, 1, 1]);
  const people = ['c', 'a', 'b'].map(agent_id => ({ agent_id, name: agent_id }));
  const bills = splitParticipantBills(people, [1, 1, 1], 2, 1);
  assert.equal(bills.reduce((sum, bill) => sum + bill.payable_cents, 0), 2);
  assert.ok(bills.every(bill => bill.payable_cents >= 0));
});

test('equal policy splits final payments equally even when separate components have remainders', () => {
  const people = ['a', 'b', 'c'].map(agent_id => ({ agent_id, name: agent_id }));
  const bills = splitParticipantBills(people, [1, 0, 0], 0, 1, 'equal');
  assert.deepEqual(bills.map(bill => bill.payable_cents), [1, 1, 0]);
  assert.equal(bills.reduce((sum, bill) => sum + bill.food_cents, 0), 1);
  assert.equal(bills.reduce((sum, bill) => sum + bill.delivery_cents, 0), 1);
});

test('an estimated cheaper candidate that violates one budget cannot win but remains quotable', () => {
  const a = participant('a', [option('a-expensive', 100), option('a-free-allowed', 0)], [rule('group', { amount_cents: 200, min_food_cents: 1000 })]);
  a.budget_cents = 50;
  const data = session([a, participant('b', [option('b-meal', 900)])]);
  const candidates = enumerateCandidates(data);
  assert.ok(candidates.some(candidate => candidate.total_cents === 800 && !candidate.estimate_budget_feasible));
  const result = optimizeSession(data);
  assert.equal(result.best.total_cents, 900);
  assert.equal(result.best.option_ids.a, 'a-free-allowed');
});

test('max_pay and stale or mismatched payer contexts are respected', () => {
  const a = participant('a', [option('a-food', 100)]);
  a.max_pay_cents = 99;
  assert.equal(optimizeSession(session([a])).best, null);
  a.max_pay_cents = 100;
  a.account.context.store_id = 'wrong-store';
  const b = participant('b', [option('b-food', 100)]);
  let result = optimizeSession(session([a, b]));
  assert.equal(result.best.owner_agent_id, 'b');
  assert.equal(result.account_candidates[0].reason, 'account_context_mismatch');
  a.account.context.store_id = 'store';
  a.account.expires_at = at;
  result = optimizeSession(session([a, b]));
  assert.equal(result.best.owner_agent_id, 'b');
});

test('cap overflow throws without returning a pruned solution or a false exact claim', () => {
  assert.throws(() => enumerateCandidates(office, { maxEvaluations: 143 }), error => error.code === 'EXACT_CAP_EXCEEDED' && error.details.exact === false);
  assert.equal(enumerateCandidates(office, { maxEvaluations: 144 }).length, 144);
  assert.throws(() => optimizeSession(office, { cap: 153 }), { code: 'EXACT_CAP_EXCEEDED' });
  assert.equal(optimizeSession(office, { cap: 154 }).audit.combinations_evaluated, 154);
});

test('official totals reallocate exactly, including a live price increase without negative discount', () => {
  const participants = [participant('a', [option('a-food', 100)]), participant('b', [option('b-food', 300)])];
  const common = { participants, option_ids: { a: 'a-food', b: 'b-food' }, split_policy: 'proportional' };
  const discounted = allocateBills({ ...common, total_cents: 303, delivery_cents: 3 });
  assert.equal(discounted.reduce((sum, bill) => sum + bill.payable_cents, 0), 303);
  assert.equal(discounted.reduce((sum, bill) => sum + bill.discount_cents, 0), 100);
  const increased = allocateBills({ ...common, total_cents: 503, delivery_cents: 3 });
  assert.equal(increased.reduce((sum, bill) => sum + bill.payable_cents, 0), 503);
  assert.ok(increased.every(bill => bill.discount_cents === 0));
  assert.throws(() => allocateBills({ ...common, total_cents: 1, delivery_cents: 2 }), { code: 'INVALID_QUOTE' });
});

test('unsafe currency, too many configurations and context-free time are rejected', () => {
  const data = session([participant('a', [option('meal', 100)])]);
  data.participants[0].options[0].price_cents = 1.5;
  assert.throws(() => optimizeSession(data), { code: 'INVALID_CENTS' });
  data.participants[0].options = Array.from({ length: 5 }, (_, index) => option(`o-${index}`, 100));
  assert.throws(() => optimizeSession(data), { code: 'INVALID_INPUT' });
  const valid = session([participant('a', [option('meal', 100)])]);
  valid.at = '2026-10-12';
  assert.throws(() => optimizeSession(valid), { code: 'INVALID_TIME' });
});

test('solver is deterministic, leaves inputs untouched, and binds candidate IDs to session context', () => {
  const data = clone(office);
  const before = JSON.stringify(data);
  const first = optimizeSession(data);
  assert.deepEqual(optimizeSession(data), first);
  assert.equal(JSON.stringify(data), before);
  data.id = 'another-session';
  assert.notEqual(optimizeSession(data).best.candidate_id, first.best.candidate_id);
});

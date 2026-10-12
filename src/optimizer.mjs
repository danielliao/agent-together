import { allocateCents, assertCents, sumCents, splitParticipantBills } from './money.mjs';
export { allocateBills } from './money.mjs';

const DEFAULT_CAP = 250000;
const TYPES = new Set(['fixed', 'percent', 'delivery_waived', 'item_fixed']);
const PRIORITY = { percent: 0, item_fixed: 1, fixed: 2, delivery_waived: 3 };
const MAX_UNITS = 10000;

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function stringId(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${label} must be a non-empty string.`);
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}

function validateSession(session, now) {
  if (!session || !Array.isArray(session.participants) || session.participants.length < 1 || session.participants.length > 8) fail('INVALID_INPUT', 'A session needs one to eight participants.');
  for (const field of ['id', 'store_id', 'service_mode', 'fulfillment_key']) stringId(session[field], field);
  if (!Number.isFinite(timestamp(session.at)) || !Number.isFinite(timestamp(now))) fail('INVALID_TIME', 'Session and evaluation times must be ISO timestamps with a timezone.');
  if (!['proportional', 'equal'].includes(session.split_policy)) fail('INVALID_INPUT', 'split_policy must be proportional or equal.');
  const agents = new Set();
  for (const participant of session.participants) {
    stringId(participant.agent_id, 'agent_id');
    if (agents.has(participant.agent_id)) fail('INVALID_INPUT', 'Participant agent IDs must be unique.');
    agents.add(participant.agent_id);
    stringId(participant.name, 'participant name');
    assertCents(participant.budget_cents, 'budget');
    if (participant.max_pay_cents !== undefined) assertCents(participant.max_pay_cents, 'max_pay_cents');
    if (!Array.isArray(participant.options) || participant.options.length < 1 || participant.options.length > 4) fail('INVALID_INPUT', 'Each participant needs one to four explicitly allowed options.');
    const options = new Set();
    for (const option of participant.options) {
      stringId(option.id, 'option ID');
      if (options.has(option.id)) fail('INVALID_INPUT', 'Option IDs must be unique within a participant.');
      options.add(option.id);
      assertCents(option.price_cents, 'option price');
      if (!Array.isArray(option.items) || !option.items.length) fail('INVALID_INPUT', 'An allowed option must contain items.');
      for (const item of option.items) {
        stringId(item.sku, 'SKU');
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_UNITS) fail('INVALID_INPUT', 'Item quantities must be positive integers no greater than 10000.');
        if (item.unit_price_cents !== undefined) assertCents(item.unit_price_cents, 'unit price');
      }
    }
    const account = participant.account ?? {};
    for (const collection of ['coupons', 'benefits']) {
      if (account[collection] !== undefined && !Array.isArray(account[collection])) fail('INVALID_INPUT', `${collection} must be an array.`);
    }
    if ((account.coupons?.length ?? 0) + (account.benefits?.length ?? 0) > 8) fail('INVALID_INPUT', 'Each account may expose at most eight coupons and benefits combined.');
    if (account.delivery_fee_cents !== undefined) assertCents(account.delivery_fee_cents, 'account delivery fee');
  }
}

function ownerReason(owner, session, nowMillis) {
  const account = owner.account;
  if (!account || account.eligible_to_order !== true) return 'account_not_eligible';
  if (!account.context || ['store_id', 'service_mode', 'fulfillment_key'].some(field => account.context[field] !== session[field])) return 'account_context_mismatch';
  const snapshot = timestamp(account.snapshot_at);
  const expiry = timestamp(account.expires_at);
  if (!Number.isFinite(snapshot) || snapshot > nowMillis || !Number.isFinite(expiry) || expiry <= nowMillis) return 'account_snapshot_expired_or_invalid';
  if (account.delivery_fee_cents === undefined) return 'delivery_fee_unknown';
  return null;
}

function scopeMatches(scope, value) {
  return scope === '*' || Array.isArray(scope) && scope.length > 0 && scope.every(item => typeof item === 'string') && (scope.includes('*') || scope.includes(value));
}

function validSkuScope(scope) {
  return scope === '*' || Array.isArray(scope) && scope.length > 0 && scope.every(item => typeof item === 'string' && item.length > 0);
}

function addIgnored(ignored, owner, rule, reason, details = {}) {
  const entry = { owner_agent_id: owner.agent_id, rule_id: typeof rule?.id === 'string' ? rule.id : null, reason, ...details };
  ignored.set(JSON.stringify(entry), entry);
}

function accountRules(owner, session, nowMillis, ignored) {
  const result = [];
  const ids = new Set();
  for (const [kind, collection] of [['coupon', owner.account?.coupons ?? []], ['benefit', owner.account?.benefits ?? []]]) {
    for (const original of collection) {
      let reason;
      if (!original || typeof original.id !== 'string' || !original.id.length || ids.has(original.id)) reason = 'invalid_or_duplicate_rule_id';
      else if (original.known !== true || !TYPES.has(original.type)) reason = 'unknown_rule';
      else if ((original.points_cost ?? 0) !== 0 || original.uses_points === true || (original.cash_cost_cents ?? 0) !== 0) reason = 'points_or_purchase_not_cash_discount';
      else if (!scopeMatches(original.store_ids, session.store_id) || !scopeMatches(original.service_modes, session.service_mode) || !scopeMatches(original.fulfillment_keys, session.fulfillment_key)) reason = 'unknown_or_inapplicable_context_scope';
      else if (!validSkuScope(original.eligible_skus)) reason = 'unknown_item_scope';
      else if (!Number.isFinite(timestamp(original.expires_at)) || timestamp(original.expires_at) <= nowMillis || (original.valid_from !== undefined && (!Number.isFinite(timestamp(original.valid_from)) || timestamp(original.valid_from) > nowMillis))) reason = 'expired_or_unknown_validity';
      else if (original.available_count !== undefined && (!Number.isSafeInteger(original.available_count) || original.available_count < 1)) reason = 'unavailable_rule';
      else if (original.stackable !== undefined && typeof original.stackable !== 'boolean') reason = 'unknown_stacking_rule';
      else if (original.group !== undefined && (typeof original.group !== 'string' || !original.group.length)) reason = 'invalid_exclusive_group';
      else if (['amount_cents', 'min_food_cents', 'max_discount_cents'].some(field => original[field] !== undefined && (!Number.isSafeInteger(original[field]) || original[field] < 0))) reason = 'invalid_rule_amount';
      else if (['min_quantity', 'max_quantity'].some(field => original[field] !== undefined && (!Number.isSafeInteger(original[field]) || original[field] < 1 || original[field] > MAX_UNITS))) reason = 'invalid_quantity_limit';
      else if (['fixed', 'item_fixed'].includes(original.type) && original.amount_cents === undefined) reason = 'missing_fixed_amount';
      else if (original.type === 'percent' && (!Number.isSafeInteger(original.discount_bps) || original.discount_bps < 0 || original.discount_bps > 10000)) reason = 'invalid_percentage';
      if (reason) {
        addIgnored(ignored, owner, original, reason);
        continue;
      }
      ids.add(original.id);
      result.push({ ...original, kind, stackable: original.stackable === true });
    }
  }
  return result;
}

function* configurations(participants, index = 0, chosen = []) {
  if (index === participants.length) {
    yield [...chosen];
    return;
  }
  for (const option of participants[index].options) {
    chosen.push(option);
    yield* configurations(participants, index + 1, chosen);
    chosen.pop();
  }
}

function cartFor(participants, chosen) {
  const units = [];
  const items = new Map();
  const foodByAgent = new Map();
  let quantity = 0;
  for (let i = 0; i < participants.length; i += 1) {
    const option = chosen[i];
    foodByAgent.set(participants[i].agent_id, option.price_cents);
    for (const item of option.items) {
      quantity += item.quantity;
      if (quantity > MAX_UNITS) fail('INPUT_TOO_LARGE', 'The selected cart exceeds the explicit 10000-unit processing limit.');
      if (!items.has(item.sku)) items.set(item.sku, { sku: item.sku, name: item.name ?? item.sku, quantity: 0 });
      items.get(item.sku).quantity += item.quantity;
    }
    let pricedItems = option.items;
    if (option.items.length === 1 && option.items[0].unit_price_cents === undefined && option.price_cents % option.items[0].quantity === 0) {
      pricedItems = [{ ...option.items[0], unit_price_cents: option.price_cents / option.items[0].quantity }];
    }
    const priced = pricedItems.every(item => item.unit_price_cents !== undefined)
      && pricedItems.reduce((sum, item) => sum + BigInt(item.unit_price_cents) * BigInt(item.quantity), 0n) === BigInt(option.price_cents);
    if (priced) {
      for (const item of pricedItems) for (let q = 0; q < item.quantity; q += 1) {
        units.push({ sku: item.sku, skus: [item.sku], quantity: 1, cents: item.unit_price_cents, key: `${i}:${units.length}` });
      }
    } else {
      units.push({ sku: null, skus: [...new Set(option.items.map(item => item.sku))], quantity: option.items.reduce((sum, item) => sum + item.quantity, 0), cents: option.price_cents, key: `${i}:${units.length}` });
    }
  }
  return { units, items: [...items.values()], foodByAgent, food_cents: sumCents([...foodByAgent.values()]) };
}

function matchesSku(rule, sku) {
  return rule.eligible_skus === '*' || rule.eligible_skus.includes('*') || rule.eligible_skus.includes(sku);
}

function cartApplicability(rule, cart) {
  if (cart.food_cents < (rule.min_food_cents ?? 0)) return 'below_food_threshold';
  const eligibleQuantity = cart.items.filter(item => matchesSku(rule, item.sku)).reduce((sum, item) => sum + item.quantity, 0);
  if (!eligibleQuantity || eligibleQuantity < (rule.min_quantity ?? 1)) return 'item_scope_or_quantity_not_met';
  if (rule.type === 'delivery_waived') return null;
  for (const unit of cart.units) {
    const matched = unit.skus.filter(sku => matchesSku(rule, sku)).length;
    if (!matched) continue;
    if (matched !== unit.skus.length || rule.type === 'item_fixed' && unit.sku === null
      || rule.max_quantity !== undefined && eligibleQuantity > rule.max_quantity && unit.sku === null) return 'target_item_price_unknown';
  }
  return null;
}

function* compatibleSubsets(rules) {
  for (let mask = 0; mask < 2 ** rules.length; mask += 1) {
    const selected = rules.filter((_, index) => mask & 2 ** index);
    if (selected.length > 1 && selected.some(rule => !rule.stackable)) continue;
    const groups = selected.filter(rule => rule.group !== undefined).map(rule => rule.group);
    if (new Set(groups).size !== groups.length) continue;
    yield selected.sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/** The arithmetic model does not invent discretionary coupon-to-item bindings. */
function assertUnambiguousRuleBindings(cart, rules) {
  const foodRules = rules.filter(rule => rule.type !== 'delivery_waived');
  const allSkus = new Set(cart.items.map(item => item.sku));
  const targetInfo = rule => {
    const items = cart.items.filter(item => matchesSku(rule, item.sku));
    const units = cart.units.filter(unit => unit.skus.every(sku => matchesSku(rule, sku)));
    const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const skus = new Set(items.map(item => item.sku));
    const credits = rule.type === 'item_fixed' ? sumCents(units.map(unit => Math.min(unit.cents, rule.amount_cents))) : 0;
    return { quantity, skus, units, credits };
  };
  for (let i = 0; i < foodRules.length; i += 1) {
    const earlier = foodRules[i];
    if (earlier.max_discount_cents === 0 || ['fixed', 'item_fixed'].includes(earlier.type) && earlier.amount_cents === 0 || earlier.type === 'percent' && earlier.discount_bps === 0) continue;
    const first = targetInfo(earlier);
    // A limited item set or capped item credit needs a binding. A fixed credit
    // over several items also has no declared attribution to those items.
    const discretionary = earlier.max_quantity !== undefined && earlier.max_quantity < first.quantity
      || earlier.type === 'fixed' && first.quantity > 1
      || earlier.type === 'item_fixed' && earlier.max_discount_cents !== undefined && earlier.max_discount_cents < first.credits && first.quantity > 1;
    if (!discretionary) continue;
    for (const later of foodRules.slice(i + 1)) {
      if (later.max_discount_cents === 0 || ['fixed', 'item_fixed'].includes(later.type) && later.amount_cents === 0 || later.type === 'percent' && later.discount_bps === 0) continue;
      const second = targetInfo(later);
      const overlaps = [...first.skus].some(sku => second.skus.has(sku));
      const laterItemSensitive = second.skus.size < allSkus.size
        || later.max_quantity !== undefined && later.max_quantity < second.quantity
        || later.type === 'item_fixed';
      if (overlaps && laterItemSensitive) fail('AMBIGUOUS_RULE_BINDING',
        'Overlapping scoped or quantity-limited discounts need explicit owner-confirmed SKU/item bindings or official pricing. No exact local optimum was returned.',
        { owner_rule_ids: [earlier.id, later.id], eligible_skus: [...first.skus].filter(sku => second.skus.has(sku)), exact: false });
    }
  }
}

function applyRules(cart, deliveryFee, rules) {
  const units = cart.units.map(unit => ({ ...unit }));
  let delivery = deliveryFee;
  const applied = [];
  for (const rule of rules) {
    if (rule.type === 'delivery_waived') {
      const saving = Math.min(delivery, rule.max_discount_cents ?? delivery);
      delivery -= saving;
      applied.push({ id: rule.id, kind: rule.kind, type: rule.type, food_discount_cents: 0, delivery_discount_cents: saving });
      continue;
    }
    let target = units.filter(unit => unit.skus.every(sku => matchesSku(rule, sku)));
    if (rule.max_quantity !== undefined) {
      target = [...target].sort((a, b) => b.cents - a.cents || (a.key < b.key ? -1 : 1));
      let allowed = rule.max_quantity;
      target = target.filter(unit => {
        if (unit.quantity > allowed) return false;
        allowed -= unit.quantity;
        return true;
      });
    }
    const eligible = sumCents(target.map(unit => unit.cents));
    const proposed = rule.type === 'item_fixed' ? target.map(unit => Math.min(unit.cents, rule.amount_cents)) : target.map(unit => unit.cents);
    const rawDiscount = rule.type === 'percent' ? Number(BigInt(eligible) * BigInt(rule.discount_bps) / 10000n)
      : rule.type === 'item_fixed' ? sumCents(proposed) : Math.min(eligible, rule.amount_cents);
    const discount = Math.min(eligible, rawDiscount, rule.max_discount_cents ?? rawDiscount);
    const portions = target.length ? allocateCents(discount, proposed, target.map(unit => unit.key)) : [];
    target.forEach((unit, index) => { unit.cents -= portions[index]; });
    applied.push({ id: rule.id, kind: rule.kind, type: rule.type, eligible_food_before_cents: eligible, food_discount_cents: discount, delivery_discount_cents: 0 });
  }
  return { food_discount_cents: cart.food_cents - sumCents(units.map(unit => unit.cents)), delivery_cents: delivery, applied };
}

function budgetViolations(participants, bills) {
  return bills.flatMap((bill, index) => {
    const participant = participants[index];
    const limit = Math.min(participant.budget_cents, participant.max_pay_cents ?? participant.budget_cents);
    return bill.payable_cents > limit ? [{ agent_id: participant.agent_id, payable_cents: bill.payable_cents, limit_cents: limit }] : [];
  });
}

function candidateFor(owner, participants, chosen, cart, rules, session, ignoredForCart) {
  assertUnambiguousRuleBindings(cart, rules);
  const result = applyRules(cart, owner.account.delivery_fee_cents, rules);
  const bills = splitParticipantBills(participants, cart.foodByAgent, result.food_discount_cents, result.delivery_cents, session.split_policy);
  const violations = budgetViolations(participants, bills);
  const option_ids = Object.fromEntries(participants.map((participant, index) => [participant.agent_id, chosen[index].id]));
  const coupon_ids = rules.filter(rule => rule.kind === 'coupon').map(rule => rule.id);
  const benefit_ids = rules.filter(rule => rule.kind === 'benefit').map(rule => rule.id);
  return {
    candidate_id: `candidate:${encodeURIComponent(JSON.stringify([session.id, session.store_id, session.service_mode, session.fulfillment_key, session.at, owner.agent_id, Object.entries(option_ids), [...coupon_ids, ...benefit_ids]]))}`,
    owner_agent_id: owner.agent_id, option_ids, coupon_ids, benefit_ids,
    items: cart.items.map(item => ({ ...item })), participant_bills: bills,
    food_cents: cart.food_cents, discount_cents: result.food_discount_cents, delivery_cents: result.delivery_cents,
    total_cents: sumCents([cart.food_cents - result.food_discount_cents, result.delivery_cents]),
    exact: true, status: 'estimate', estimate_budget_feasible: violations.length === 0,
    audit: { applied_rules: result.applied, ignored_rules: ignoredForCart, budget_violations: violations, application_order: 'percent → item_fixed → fixed → delivery_waived; same-type rule IDs ascending', threshold_basis: 'original food subtotal', local_pricing_model: 'integer aggregate percentage floor; food-credit attribution by largest remainder; ambiguous overlapping discretionary bindings rejected', split_policy: session.split_policy },
  };
}

function checkCap(counter) {
  counter.count += 1;
  if (counter.count > counter.limit) fail('EXACT_CAP_EXCEEDED', 'Exact enumeration exceeds the cap; narrow explicitly allowed options or rules before retrying.', { max_evaluations: counter.limit, required_at_least: counter.count, exact: false });
}

function capValue(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_CAP', 'The exact-evaluation cap must be a positive safe integer.');
  return value;
}

function collectCandidates(session, participants, owners, nowMillis, counter, ignored) {
  const candidates = [];
  for (const owner of owners) {
    if (ownerReason(owner, session, nowMillis)) continue;
    const rules = accountRules(owner, session, nowMillis, ignored);
    const staticIgnored = [...ignored.values()].filter(entry => entry.owner_agent_id === owner.agent_id && !entry.scope);
    for (const chosen of configurations(participants)) {
      const cart = cartFor(participants, chosen);
      const applicable = [];
      const ignoredForCart = [...staticIgnored];
      for (const rule of rules) {
        const reason = cartApplicability(rule, cart);
        if (!reason) applicable.push(rule);
        else {
          const entry = { owner_agent_id: owner.agent_id, rule_id: rule.id, reason };
          ignoredForCart.push(entry);
          if (reason === 'target_item_price_unknown') addIgnored(ignored, owner, rule, reason, { scope: 'some_configurations' });
        }
      }
      for (const selectedRules of compatibleSubsets(applicable)) {
        checkCap(counter);
        candidates.push(candidateFor(owner, participants, chosen, cart, selectedRules, session, ignoredForCart));
      }
    }
  }
  return candidates;
}

function prefer(a, b) {
  return a.total_cents - b.total_cents
    || (a.coupon_ids.length + a.benefit_ids.length) - (b.coupon_ids.length + b.benefit_ids.length)
    || (a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0);
}

/** Includes over-budget estimates so live quotes are never pruned by estimated prices. */
export function enumerateCandidates(session, { maxEvaluations = DEFAULT_CAP, now = session.at } = {}) {
  validateSession(session, now);
  return collectCandidates(session, session.participants, session.participants, timestamp(now), { count: 0, limit: capValue(maxEvaluations) }, new Map());
}

export function optimizeSession(session, { cap = DEFAULT_CAP, now = session.at } = {}) {
  validateSession(session, now);
  const nowMillis = timestamp(now);
  const counter = { count: 0, limit: capValue(cap) };
  const ignored = new Map();
  const candidates = collectCandidates(session, session.participants, session.participants, nowMillis, counter, ignored);
  const feasible = candidates.filter(candidate => candidate.estimate_budget_feasible).sort(prefer);
  const account_candidates = session.participants.map(owner => ({
    owner_agent_id: owner.agent_id,
    best: feasible.find(candidate => candidate.owner_agent_id === owner.agent_id) ?? null,
    reason: ownerReason(owner, session, nowMillis) ?? (feasible.some(candidate => candidate.owner_agent_id === owner.agent_id) ? null : 'no_budget_feasible_configuration'),
  }));
  const solos = session.participants.map(participant => {
    const choices = collectCandidates(session, [participant], [participant], nowMillis, counter, ignored).filter(candidate => candidate.estimate_budget_feasible).sort(prefer);
    return { agent_id: participant.agent_id, name: participant.name, best: choices[0] ?? null, reason: ownerReason(participant, session, nowMillis) ?? (choices.length ? null : 'no_budget_feasible_configuration') };
  });
  const available = solos.every(solo => solo.best !== null);
  const baselineTotal = available ? sumCents(solos.map(solo => solo.best.total_cents)) : null;
  const savings = feasible.length && available ? baselineTotal - feasible[0].total_cents : null;
  return {
    version: 1, exact: true, status: 'estimate',
    account_candidates,
    best: feasible.length ? { ...feasible[0], savings_cents: savings } : null,
    solo_baseline: { available, total_cents: baselineTotal, participants: solos },
    savings_cents: savings,
    audit: { combinations_evaluated: counter.count, group_candidates: candidates.length, ignored_rules: [...ignored.values()], exact_scope: 'all explicitly allowed configurations and known, eligible declared rules; not live verified prices', max_evaluations: counter.limit },
  };
}

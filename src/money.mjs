const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function moneyError(code, message) {
  const error = new RangeError(message);
  error.code = code;
  throw error;
}

export function assertCents(value, label = 'amount') {
  if (!Number.isSafeInteger(value) || value < 0) moneyError('INVALID_CENTS', `${label} must be a non-negative safe integer in cents.`);
  return value;
}

export function sumCents(values) {
  const total = values.reduce((sum, value) => sum + BigInt(assertCents(value)), 0n);
  if (total > MAX_SAFE) moneyError('AMOUNT_OVERFLOW', 'The amount exceeds the safe integer range.');
  return Number(total);
}

/** Integer Hamilton allocation. Equal remainders use a stable, explicit tie key. */
export function allocateCents(total, weights, tieKeys = []) {
  assertCents(total, 'total');
  if (!Array.isArray(weights) || !weights.length) moneyError('INVALID_WEIGHTS', 'At least one weight is required.');
  const integerWeights = weights.map(weight => BigInt(assertCents(weight, 'weight')));
  const denominator = integerWeights.reduce((a, b) => a + b, 0n);
  if (!denominator) {
    if (!total) return weights.map(() => 0);
    moneyError('INVALID_WEIGHTS', 'Positive totals require at least one positive weight.');
  }
  const allocations = integerWeights.map(weight => Number(BigInt(total) * weight / denominator));
  const ranked = integerWeights.map((weight, index) => ({
    index, remainder: BigInt(total) * weight % denominator, key: String(tieKeys[index] ?? index),
  })).sort((a, b) => a.remainder === b.remainder
    ? (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index)
    : a.remainder > b.remainder ? -1 : 1);
  const extra = total - sumCents(allocations);
  for (let i = 0; i < extra; i += 1) allocations[ranked[i].index] += 1;
  return allocations;
}

function foodValues(participants, foodByAgent) {
  return participants.map((participant, index) => assertCents(
    foodByAgent instanceof Map ? foodByAgent.get(participant.agent_id)
      : Array.isArray(foodByAgent) ? foodByAgent[index] : foodByAgent[participant.agent_id],
    `food for ${participant.agent_id}`,
  ));
}

export function splitParticipantBills(participants, foodByAgent, discount, delivery, policy = 'proportional') {
  if (!Array.isArray(participants) || !participants.length) moneyError('INVALID_PARTICIPANTS', 'Participants are required.');
  if (!['proportional', 'equal'].includes(policy)) moneyError('INVALID_SPLIT_POLICY', 'Unknown split policy.');
  const food = foodValues(participants, foodByAgent);
  const foodTotal = sumCents(food);
  assertCents(discount, 'discount');
  assertCents(delivery, 'delivery');
  if (discount > foodTotal) moneyError('INVALID_DISCOUNT', 'Food discount cannot exceed food cost.');
  const keys = participants.map(participant => participant.agent_id);
  const equalWeights = participants.map(() => 1);
  let foods, discounts, deliveries;
  if (policy === 'proportional') {
    foods = food;
    discounts = allocateCents(discount, food, keys);
    deliveries = allocateCents(delivery, equalWeights, keys);
  } else {
    // Equal means equal final payment (apart from the unavoidable one-cent remainder).
    const netFoods = allocateCents(foodTotal - discount, equalWeights, keys);
    const finalPayments = allocateCents(sumCents([foodTotal - discount, delivery]), equalWeights, keys);
    discounts = allocateCents(discount, equalWeights, keys);
    foods = netFoods.map((amount, index) => sumCents([amount, discounts[index]]));
    deliveries = finalPayments.map((amount, index) => amount - netFoods[index]);
  }
  return participants.map((participant, index) => ({
    agent_id: participant.agent_id, name: participant.name,
    food_cents: foods[index], discount_cents: discounts[index], delivery_cents: deliveries[index],
    payable_cents: sumCents([foods[index] - discounts[index], deliveries[index]]),
  }));
}

/** Re-split an official total. No assumption that the earlier estimate was a live quote. */
export function allocateBills({ participants, option_ids, total_cents, delivery_cents, split_policy = 'proportional' }) {
  assertCents(total_cents, 'official total');
  assertCents(delivery_cents, 'official delivery');
  if (delivery_cents > total_cents) moneyError('INVALID_QUOTE', 'Delivery cannot exceed the official total.');
  const originalFood = participants.map((participant, index) => {
    const optionId = Array.isArray(option_ids) ? option_ids[index] : option_ids?.[participant.agent_id];
    const option = participant.options?.find(candidate => candidate.id === optionId);
    if (!option) moneyError('UNKNOWN_OPTION', `Option for ${participant.agent_id} is not explicitly allowed.`);
    return assertCents(option.price_cents, 'allowed option price');
  });
  const originalTotal = sumCents(originalFood);
  const officialNetFood = total_cents - delivery_cents;
  if (officialNetFood <= originalTotal) {
    return splitParticipantBills(participants, originalFood, originalTotal - officialNetFood, delivery_cents, split_policy);
  }
  // A higher live food price is a price change, never a fictional negative discount.
  const weights = originalTotal ? originalFood : participants.map(() => 1);
  const actualFood = allocateCents(officialNetFood, weights, participants.map(participant => participant.agent_id));
  return splitParticipantBills(participants, actualFood, 0, delivery_cents, split_policy);
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename, unlink, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { McpClient, McpError } from './mcp.mjs';
import { officialPayload, historyRecords, completedOrder, unknownOrderStatus, summarizeHistory, publicText } from './history.mjs';

const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clone = value => structuredClone(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
const decision = candidate => ({ owner_agent_id: candidate.owner_agent_id, option_ids: candidate.option_ids, coupon_ids: candidate.coupon_ids ?? [], benefit_ids: candidate.benefit_ids ?? [] });
function fail(code, message) { throw new McpError(code, message); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function modifier(input) {
  if (!object(input) || !Array.isArray(input.values)) fail('invalid_candidate', '餐品特制选项结构未确认。');
  return { values: input.values.map(value => {
    if (!identifier(String(value?.code ?? '')) || !Number.isSafeInteger(value.quantity) || value.quantity < 0 || value.quantity > 100 || typeof value.key !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(value.key)) fail('invalid_candidate', '特制编码、份数或选择 key 未确认。');
    return { code: String(value.code), quantity: value.quantity, key: value.key };
  }) };
}
function itemConfiguration(item) {
  const result = { sku: String(item.sku), quantity: item.quantity };
  if (item.modification) result.modification = modifier(item.modification);
  if (item.roundList) {
    if (!Array.isArray(item.roundList)) fail('invalid_candidate', '套餐配置列表未经确认。');
    result.roundList = item.roundList.map(group => {
      if (!identifier(String(group?.round ?? '')) || !Array.isArray(group.comboItemList)) fail('invalid_candidate', '套餐分组未经确认。');
      return { round: group.round, comboItemList: group.comboItemList.map(child => {
        if (!identifier(String(child?.code ?? '')) || !Number.isSafeInteger(child.quantity) || child.quantity < 1 || child.quantity > 100) fail('invalid_candidate', '套餐选项编码或数量未经确认。');
        return { code: String(child.code), quantity: child.quantity, ...(child.modification ? { modification: modifier(child.modification) } : {}) };
      }) };
    });
  }
  return result;
}
function cartFingerprint(candidate, session, context, profile) {
  const combined = new Map();
  for (const participant of session.participants) {
    const option = participant.options?.find(option => option.id === candidate.option_ids[participant.agent_id]);
    if (!option) fail('invalid_candidate', '无法核对原始餐品篮子。');
    for (const item of option.items) {
      const configuration = itemConfiguration(item);
      const quantity = configuration.quantity; delete configuration.quantity;
      const key = stable(configuration);
      combined.set(key, (combined.get(key) ?? 0) + quantity);
    }
  }
  return hash({ storeCode: String(context.storeCode), beType: Number(context.beType), orderType: Number(context.orderType), reservationDate: context.reservationDate ?? null,
    fulfillment_key: profile.fulfillment_key, address_id: Number(context.beType) === 2 ? profile.addressId ?? null : null,
    items: [...combined].sort(([a], [b]) => a.localeCompare(b)).map(([configuration, quantity]) => ({ configuration, quantity })) });
}
export function yuanToCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') fail('unsupported_price_unit', '未确认金额格式，不能用于分账。');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) fail('unsupported_price_unit', '元金额必须精确到最多两位小数。');
  const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!cents(result)) fail('unsupported_price_unit', '金额超出可确认范围。');
  return result;
}

function sanitizeRule(rule, alias) {
  const result = { id: alias, name: publicText(rule?.name || '账户优惠'), known: false };
  if (rule?.known !== true) return result;
  const types = ['fixed', 'percent', 'delivery_waived', 'item_fixed'];
  if (!types.includes(rule.type) || !Number.isFinite(Date.parse(rule.expires_at))) return result;
  const normalized = { ...result, type: rule.type, known: true, expires_at: rule.expires_at };
  for (const key of ['store_ids', 'service_modes', 'fulfillment_keys', 'eligible_skus']) {
    if (rule[key] === '*') normalized[key] = '*';
    else if (Array.isArray(rule[key]) && rule[key].every(identifier)) normalized[key] = [...rule[key]];
    else return result;
  }
  for (const key of ['amount_cents', 'discount_bps', 'max_discount_cents', 'max_quantity', 'min_quantity', 'available_count', 'min_food_cents', 'points_cost', 'cash_cost_cents']) {
    if (rule[key] !== undefined) {
      if (!cents(rule[key])) return result;
      normalized[key] = rule[key];
    }
  }
  if (rule.stackable !== undefined) normalized.stackable = rule.stackable === true;
  if (rule.uses_points !== undefined) normalized.uses_points = rule.uses_points === true;
  if (rule.valid_from !== undefined) { if (!Number.isFinite(Date.parse(rule.valid_from))) return result; normalized.valid_from = rule.valid_from; }
  if (identifier(rule.group)) normalized.group = rule.group;
  return normalized;
}

/** Each instance belongs to one owner. Its Token and raw coupon/order identifiers stay local. */
export class MemberAgent {
  #profile; #client; #tools; #state; #statePath; #now; #busy = false;
  constructor({ token, profile, client, ledgerPath, now = () => Date.now() } = {}) {
    if (!object(profile) || !identifier(profile.agent_id)) fail('invalid_profile', '本机 profile 需要有效 agent_id。');
    if (profile.max_pay_cents !== undefined && !cents(profile.max_pay_cents)) fail('invalid_owner_limit', '主人硬支付上限必须是非负整数分，不能省略或放宽无效值。');
    this.agent_id = profile.agent_id;
    this.#profile = clone(profile);
    this.#client = client ?? new McpClient({ token });
    this.#statePath = resolve(ledgerPath ?? profile.ledger_path ?? `work/member-${profile.agent_id}.private.json`);
    this.#now = now;
  }
  async #load() {
    try {
      const state = JSON.parse(await readFile(this.#statePath, 'utf8'));
      if (state.version !== 1 || state.agent_id !== this.agent_id || !object(state.orders)) fail('invalid_local_ledger', '本机订单台账格式不符；未执行创建。');
      this.#state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof McpError) throw error;
        fail('invalid_local_ledger', '本机订单台账不可读取；未执行创建。');
      }
      this.#state = { version: 1, agent_id: this.agent_id, coupons: {}, quotes: {}, orders: {}, approval: null };
    }
    return this.#state;
  }
  async #save() {
    const directory = dirname(this.#statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temp = `${this.#statePath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.#state)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      const handle = await open(temp, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.#statePath);
      await chmod(this.#statePath, 0o600);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async #locked(operation) {
    if (this.#busy) fail('local_operation_in_progress', '本机 Agent 正在处理另一项操作。');
    this.#busy = true;
    let lock;
    try {
      await mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.#statePath), 0o700);
      try { lock = await open(`${this.#statePath}.lock`, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('local_operation_in_progress', '本机台账已锁定；请核实先前操作结果，不能重复创建。'); throw error; }
      await this.#load();
      return await operation();
    } finally {
      if (lock) { await lock.close(); await unlink(`${this.#statePath}.lock`).catch(() => {}); }
      this.#busy = false;
    }
  }
  async #schemas() {
    if (!this.#tools) this.#tools = await this.#client.listTools();
    return this.#tools;
  }
  async #args(name, values = {}) {
    const tool = (await this.#schemas()).find(tool => tool.name === name);
    if (!tool) fail('tool_unavailable', '当前服务没有所需工具。');
    const schema = tool.inputSchema;
    if (!object(schema) || schema.$ref) fail('invalid_tool_schema', '当前工具合约未确认。');
    const supplied = { ...(this.#profile.tool_args?.[name] ?? {}), ...values };
    if (supplied.withOrder !== undefined) fail('additional_purchase_not_supported', '首版不自动购买权益卡，不能通过工具补充参数加入随单购。');
    const properties = schema.properties ?? {};
    const requiredContract = { 'calculate-price': ['storeCode', 'beType', 'orderType', 'items'], 'create-order': ['storeCode', 'beType', 'items'], 'query-order': ['orderId'], 'query-meal-detail': ['code', 'storeCode', 'beType', 'orderType'], 'query-store-coupons': ['storeCode', 'beType', 'orderType'], 'query-meals': ['storeCode', 'beType', 'orderType'] };
    if ((requiredContract[name] ?? []).some(key => !Object.hasOwn(properties, key))) fail('invalid_tool_schema', '当前工具缺少已确认的官方参数合约，未猜测映射。');
    const result = {};
    for (const [key, value] of Object.entries(supplied)) {
      if (!Object.hasOwn(properties, key)) {
        if (Object.hasOwn(this.#profile.tool_args?.[name] ?? {}, key)) fail('invalid_arguments', '本机工具参数与当前合约不一致。');
        continue;
      }
      const type = properties[key]?.type;
      result[key] = type === 'string' && typeof value === 'number' ? String(value) : value;
    }
    return result;
  }
  #context(session) {
    const context = clone(this.#profile.context ?? {});
    if (!context.storeCode || ![1, 2].includes(Number(context.beType))) fail('invalid_profile', '本机 profile 需要当前门店与到店/外送类型。');
    const service = Number(context.beType) === 2 ? 'delivery' : 'pickup';
    if (session && (String(session.store_id) !== String(context.storeCode) || session.service_mode !== service || session.fulfillment_key !== this.#profile.fulfillment_key)) fail('context_mismatch', '拼单门店、取餐方式或共同地点与主人当前设置不一致。');
    if (context.orderType === undefined) context.orderType = Number(context.beType) === 2 ? 2 : 1;
    return context;
  }
  #options(menu) {
    if (!Array.isArray(this.#profile.options) || !this.#profile.options.length || this.#profile.options.length > 4) fail('missing_owner_choices', '主人需要先声明 1–4 项愿意接受的餐品配置。');
    return this.#profile.options.map(option => {
      if (!identifier(option.id) || !Array.isArray(option.items) || !option.items.length) fail('invalid_profile', '主人可选餐品配置无效。');
      let sum = 0;
      const items = option.items.map(item => {
        const sku = String(item.sku ?? '');
        const entry = menu[sku];
        if (!entry || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) fail('current_sku_unavailable', '主人选择的餐品未在当前门店菜单确认，或份数超限；不能用历史编码代替。');
        const unit = yuanToCents(typeof entry.discountType === 'string' && entry.discountType.startsWith('随单购') ? entry.originalPrice : entry.currentPrice);
        sum += unit * item.quantity;
        return { ...itemConfiguration({ ...item, sku }), name: publicText(entry.name), unit_price_cents: unit };
      });
      // Customized combos need a current configured price; menu base price is only an estimate.
      const price = option.items.some(item => item.modification || item.roundList) ? option.price_cents : sum;
      if (!cents(price)) fail('invalid_profile', '特制配置需要主人提供当前可核价的分金额。');
      return { id: option.id, label: publicText(option.label ?? items.map(item => item.name).join(' + ')), price_cents: price, items };
    });
  }
  async #validateConfigurations(context) {
    for (const option of this.#profile.options ?? []) for (const item of option.items ?? []) {
      if (!item.modification && !item.roundList) continue;
      const detail = officialPayload(await this.#client.callTool('query-meal-detail', await this.#args('query-meal-detail', { ...context, code: String(item.sku) }))).data;
      if (!object(detail) || String(detail.code) !== String(item.sku)) fail('configuration_unconfirmed', '当前餐品详情未确认配置对应的编码。');
      if (item.roundList) fail('configuration_unconfirmed', '公开详情示例未确认 rounds 的可替换分组字段；当前首版不猜测套餐更换配置。');
      if (detail.supportModify !== true || !Array.isArray(detail.modification?.items)) fail('configuration_unconfirmed', '当前餐品未确认支持特制。');
      const values = detail.modification.items.flatMap(group => Array.isArray(group.values) ? group.values : []);
      for (const chosen of modifier(item.modification).values) {
        const value = values.find(value => String(value.code) === chosen.code);
        if (!value || !Number.isSafeInteger(value.minQuantity) || !Number.isSafeInteger(value.maxQuantity) || chosen.quantity < value.minQuantity || chosen.quantity > value.maxQuantity || !((chosen.quantity === 0 && chosen.key === value.unselectedKey) || (chosen.quantity === value.selectedQuantity && chosen.key === value.selectedKey))) fail('configuration_unconfirmed', '特制选项与当前官方编码、数量或选择 key 不一致。');
      }
    }
  }
  async collect() {
    return this.#locked(async () => {
      const context = this.#context();
      if (!cents(this.#profile.budget_cents)) fail('missing_owner_budget', '主人需在本机明确本次可接受的分金额预算。');
      const records = historyRecords(await this.#client.callTool('order-list', await this.#args('order-list')));
      const history = [];
      for (const record of records) {
        if (!completedOrder(record) && unknownOrderStatus(record) && typeof record.orderId === 'string' && (await this.#schemas()).some(tool => tool.name === 'query-order')) {
          try { history.push(officialPayload(await this.#client.callTool('query-order', await this.#args('query-order', { orderId: record.orderId }))).data); }
          catch (error) { if (error.code === 'authentication_failed') throw error; history.push(record); }
        } else history.push(record);
      }
      // Account-wide coupons may be Markdown; never turn titles into invented numeric rules.
      await this.#client.callTool('query-my-coupons', await this.#args('query-my-coupons'));
      await this.#client.callTool('query-my-account', await this.#args('query-my-account'));
      const couponData = officialPayload(await this.#client.callTool('query-store-coupons', await this.#args('query-store-coupons', context))).data;
      const menu = officialPayload(await this.#client.callTool('query-meals', await this.#args('query-meals', context))).data?.meals;
      if (!Array.isArray(couponData) || !object(menu)) fail('unsupported_response_schema', '当前门店券或菜单结构未经确认。');
      await this.#validateConfigurations(context);
      const benefits = [...new Set(Object.values(menu).map(entry => entry.discountType).filter(value => value === '麦金卡优惠' || value === '早餐卡优惠'))].map((name, index) => ({ id: `benefit-${this.agent_id}-${index + 1}`, name, known: false, rule_source: 'account_menu_price_only' }));
      const coupons = [];
      const nextCoupons = {};
      for (const raw of couponData) {
        if (typeof raw.couponId !== 'string' || typeof raw.couponCode !== 'string' || !Array.isArray(raw.products)) fail('unsupported_response_schema', '门店优惠券缺少官方标识或商品映射。');
        const previous = Object.entries(this.#state.coupons).find(([, saved]) => saved.raw.couponId === raw.couponId);
        const alias = previous?.[0] ?? `coupon-${randomUUID()}`;
        const mapping = this.#profile.coupon_bindings?.[raw.couponId] ?? this.#profile.coupon_bindings?.[alias] ?? null;
        nextCoupons[alias] = { raw: clone(raw), mapping: mapping ? clone(mapping) : null };
        const rule = this.#profile.coupon_rules?.[raw.couponId] ?? this.#profile.coupon_rules?.[alias];
        const configured = mapping && identifier(mapping.agent_id) && identifier(mapping.option_id) && Number.isSafeInteger(mapping.item_index) && mapping.item_index >= 0 && identifier(String(mapping.base_productCode ?? '')) && raw.products.some(product => String(product.productCode) === String(mapping.productCode)) && (String(mapping.productCode) === String(mapping.base_productCode) || mapping.replacement_confirmed === true);
        const paidRule = rule?.uses_points === true || Number(rule?.points_cost) > 0 || Number(rule?.cash_cost_cents) > 0;
        coupons.push({ ...sanitizeRule(rule, alias), name: publicText(raw.title || '当前门店优惠券'),
          product_skus: raw.products.map(item => String(item.productCode)).filter(identifier),
          ...(configured && !paidRule ? { quote_only: true, binding_summary: { agent_id: mapping.agent_id, option_id: mapping.option_id, item_index: mapping.item_index, base_sku: String(mapping.base_productCode), product_sku: String(mapping.productCode), owner_confirmed: true } } : {}),
          rule_source: rule?.known === true ? 'owner_declared_estimate' : 'official_summary_rule_unknown' });
      }
      this.#state.coupons = nextCoupons;
      await this.#save();
      const now = this.#now(), ttl = Math.min(300_000, Math.max(1_000, this.#profile.snapshot_ttl_ms ?? 180_000));
      const selected = this.#profile.selected_coupon_ids;
      const selectedCoupons = Array.isArray(selected) ? coupons.filter(coupon => selected.includes(coupon.id) || selected.includes(nextCoupons[coupon.id].raw.couponId)) : [...coupons].sort((a, b) => Number(b.quote_only === true) - Number(a.quote_only === true));
      const sharedCoupons = selectedCoupons.slice(0, Math.max(0, 8 - benefits.length));
      this.#state.shared_coupon_aliases = sharedCoupons.map(coupon => coupon.id);
      await this.#save();
      return { agent_id: this.agent_id, name: publicText(this.#profile.name ?? this.#profile.display_name ?? this.agent_id),
        options: this.#options(menu), budget_cents: this.#profile.budget_cents,
        ...(this.#profile.max_pay_cents !== undefined ? { max_pay_cents: this.#profile.max_pay_cents } : {}),
        history: summarizeHistory(history, { shared: this.#profile.history?.shared === true }),
        account: { context: { store_id: String(context.storeCode), service_mode: Number(context.beType) === 2 ? 'delivery' : 'pickup', fulfillment_key: this.#profile.fulfillment_key },
          snapshot_at: new Date(now).toISOString(), expires_at: new Date(now + ttl).toISOString(), eligible_to_order: Number(context.beType) === 2 ? identifier(String(this.#profile.addressId ?? '')) : identifier(String(this.#profile.takeWayCode ?? '')),
          delivery_fee_cents: null, coupons: sharedCoupons, benefits, source: 'mcp',
          coupon_selection_note: { available_count: coupons.length, shared_count: sharedCoupons.length, complete: sharedCoupons.length === coupons.length, scope: Array.isArray(selected) ? 'owner_selected' : 'limited_summary', note: '报价只覆盖共享且本机明确绑定的候选券，不能称为所有账户优惠的全局最优。' } } };
    });
  }
  #basket(candidate, session) {
    if (candidate.owner_agent_id !== this.agent_id || !object(candidate.option_ids) || !Array.isArray(session?.participants) || !session.participants.length || session.participants.length > 30 || new Set(session.participants.map(member => member.agent_id)).size !== session.participants.length || !session.participants.some(member => member.agent_id === this.agent_id)) fail('invalid_candidate', '当前候选不是本机主人付款的完整拼单。');
    const items = [];
    for (const participant of session.participants) {
      const option = participant.options?.find(option => option.id === candidate.option_ids[participant.agent_id]);
      if (!option || !Array.isArray(option.items) || !option.items.length) fail('invalid_candidate', '候选未包含每位成员已声明的可选餐品。');
      if (participant.agent_id === this.agent_id) {
        const own = this.#profile.options?.find(own => own.id === option.id);
        if (!own || hash(own.items.map(itemConfiguration)) !== hash(option.items.map(itemConfiguration))) fail('owner_choice_changed', '协调器餐品配置与主人本机允许的选择不一致。');
      }
      option.items.forEach((item, index) => {
        if (!identifier(String(item.sku)) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) fail('invalid_candidate', '候选餐品编码或数量无效。');
        const configuration = itemConfiguration(item);
        items.push({ participant_id: participant.agent_id, option_id: option.id, item_index: index,
          value: { productCode: configuration.sku, quantity: configuration.quantity, ...(configuration.modification ? { modification: configuration.modification } : {}), ...(configuration.roundList ? { roundList: configuration.roundList } : {}) } });
      });
    }
    for (const alias of candidate.coupon_ids ?? []) {
      const saved = this.#state.coupons[alias];
      if (!saved || !this.#state.shared_coupon_aliases?.includes(alias) || !object(saved.mapping)) fail('coupon_binding_unconfirmed', '所选优惠券未在付款 Agent 本机确认具体商品绑定。');
      const matches = items.filter(item => item.participant_id === saved.mapping.agent_id && item.option_id === saved.mapping.option_id && item.item_index === saved.mapping.item_index);
      const target = matches[0];
      const couponProduct = saved.raw.products.find(item => String(item.productCode) === String(saved.mapping.productCode));
      if (matches.length !== 1 || !couponProduct || target.value.couponId || target.value.quantity !== 1 || String(saved.mapping.base_productCode) !== target.value.productCode || (String(couponProduct.productCode) !== target.value.productCode && saved.mapping.replacement_confirmed !== true)) fail('coupon_binding_unconfirmed', '券与商品绑定、等价替换或多份核销规则不明，未猜测叠加。');
      target.value.productCode = String(couponProduct.productCode);
      target.value.couponId = saved.raw.couponId;
      target.value.couponCode = saved.raw.couponCode;
    }
    if ((candidate.benefit_ids ?? []).length) fail('benefit_binding_unconfirmed', '权益卡只通过本人官方当前价核验，不接受伪造权益参数。');
    return items.map(item => item.value);
  }
  #confirmedPrice(raw) {
    const data = officialPayload(raw).data;
    if (!object(data) || !cents(data.price) || !cents(data.deliveryPrice) || !cents(data.productPrice) || !Array.isArray(data.productList) || !data.productList.length) fail('unsupported_price_schema', '官方核价未提供可确认的整数分金额与商品明细。');
    for (const product of data.productList) if (!identifier(String(product.productCode ?? '')) || !cents(product.subtotal) || !cents(product.originalSubtotal) || !Number.isSafeInteger(product.quantity) || product.quantity < 1) fail('unsupported_price_schema', '官方核价商品分金额未经确认。');
    return data;
  }
  #confirmPricedBasket(data, items) {
    const group = values => {
      const map = new Map();
      for (const item of values) map.set(String(item.productCode), (map.get(String(item.productCode)) ?? 0) + item.quantity);
      return [...map].sort(([a], [b]) => a.localeCompare(b));
    };
    if (stable(group(data.productList)) !== stable(group(items))) fail('quote_cart_mismatch', '官方核价商品编码或份数与完整拼单不一致，未宣称核价成功。');
  }
  async quote(input, sessionArg, options = {}) {
    const wrapped = input?.candidate ? input : { candidate: input, session: sessionArg, ...options };
    return this.#locked(async () => {
      const { candidate, session } = wrapped;
      const context = this.#context(session);
      const candidateId = wrapped.candidate_id ?? candidate?.candidate_id ?? hash(candidate);
      if (!identifier(candidateId)) fail('invalid_candidate', '候选标识无效。');
      const items = this.#basket(candidate, session);
      const args = await this.#args('calculate-price', { ...context, items, ...(this.#profile.needTableware !== undefined ? { needTableware: this.#profile.needTableware } : {}) });
      const data = this.#confirmedPrice(await this.#client.callTool('calculate-price', args));
      this.#confirmPricedBasket(data, items);
      const now = this.#now(), ttl = Math.min(300_000, Math.max(1_000, this.#profile.quote_ttl_ms ?? 120_000));
      const result = { candidate_id: candidateId, owner_agent_id: this.agent_id, total_cents: data.price, delivery_cents: data.deliveryPrice,
        verified: true, quoted_at: new Date(now).toISOString(), expires_at: new Date(now + ttl).toISOString() };
      this.#state.quotes[candidateId] = { candidate_hash: hash(decision(candidate)), session_hash: hash({ id: session.id, store_id: session.store_id, service_mode: session.service_mode, fulfillment_key: session.fulfillment_key, participant_ids: session.participants.map(participant => participant.agent_id) }), args,
        price: clone(data), result, items, cart_hash: cartFingerprint(candidate, session, context, this.#profile) };
      await this.#save();
      return result;
    });
  }
  async approveLocal(planHash, { explicitOwnerApproval = false, purpose = 'checkout' } = {}) {
    if (explicitOwnerApproval !== true || !/^[a-f0-9]{64}$/.test(planHash ?? '')) fail('owner_approval_required', '本机主人需明确确认当前方案哈希。');
    if (!['checkout', 'settlement'].includes(purpose)) fail('invalid_approval_purpose', '批准用途只能为创建订单或确认已支付分账。');
    return this.#locked(async () => {
      this.#state.approval = { plan_hash: planHash, purpose, approved_at: new Date(this.#now()).toISOString(), expires_at: new Date(this.#now() + 900_000).toISOString() };
      await this.#save();
      return { agent_id: this.agent_id, plan_hash: planHash, approved: true, purpose };
    });
  }
  async checkout({ candidate_id, candidate, session, plan_hash, approval_receipts } = {}) {
    return this.#locked(async () => {
      if (!/^[a-f0-9]{64}$/.test(plan_hash ?? '') || session?.plan_hash !== plan_hash) fail('plan_mismatch', '当前方案哈希未确认。');
      const approval = this.#state.approval;
      if (approval?.plan_hash !== plan_hash || approval.purpose !== 'checkout' || Date.parse(approval.expires_at) <= this.#now()) fail('owner_approval_required', '付款主人未在本机明确授权创建此方案，或批准仅用于已支付分账/已失效。');
      for (const participant of session.participants ?? []) if (!approval_receipts?.some(receipt => receipt.agent_id === participant.agent_id && receipt.plan_hash === plan_hash && receipt.approved === true)) fail('member_approval_required', '当前方案尚未获得每位成员确认。');
      const previous = this.#state.orders[plan_hash];
      if (previous) return this.#publicOrder(previous); // Includes unknown outcomes: never replay.
      const context = this.#context(session);
      const currentCartHash = cartFingerprint(candidate, session, context, this.#profile);
      const unresolved = Object.values(this.#state.orders).find(order => !['completed', 'cancelled', 'owner_confirmed_not_created'].includes(order.status) && (order.session_id === session.id || order.cart_hash === currentCartHash || (!order.session_id && !order.cart_hash)));
      if (unresolved) fail('unresolved_prior_order', '同一局或同篮子已有待支付/结果未确认订单；请主人先核实，不能换方案哈希重复创建。');
      const saved = this.#state.quotes[candidate_id];
      const sessionHash = hash({ id: session.id, store_id: session.store_id, service_mode: session.service_mode, fulfillment_key: session.fulfillment_key, participant_ids: session.participants.map(participant => participant.agent_id) });
      if (!saved || saved.candidate_hash !== hash(decision(candidate)) || saved.session_hash !== sessionHash || hash(saved.items) !== hash(this.#basket(candidate, session)) || Date.parse(saved.result.expires_at) <= this.#now()) fail('quote_expired_or_changed', '本机核价已失效或候选内容变化，请重新核价并确认。');
      this.#context(session);
      const repriced = this.#confirmedPrice(await this.#client.callTool('calculate-price', saved.args));
      this.#confirmPricedBasket(repriced, saved.items);
      if (repriced.price !== saved.result.total_cents || repriced.deliveryPrice !== saved.result.delivery_cents || candidate.total_cents !== saved.result.total_cents) {
        this.#state.approval = null; await this.#save();
        return { status: 'PRICE_CHANGED', candidate_id, owner_agent_id: this.agent_id, total_cents: repriced.price, delivery_cents: repriced.deliveryPrice, verified: true };
      }
      const takeWayCode = this.#profile.takeWayCode;
      if (Number(context.beType) === 2 && !this.#profile.addressId) fail('owner_address_required', '外送下单需要付款主人账号自己的配送地址 ID。');
      if (Number(context.beType) === 1 && (!takeWayCode || !Array.isArray(repriced.takeWayList) || !repriced.takeWayList.some(entry => entry.code === takeWayCode))) fail('take_way_unconfirmed', '取餐方式需匹配本次官方核价的 takeWayList.code；未猜测其他字段。');
      const createArgs = await this.#args('create-order', { ...context, items: saved.items,
        ...(Number(context.beType) === 2 ? { addressId: this.#profile.addressId } : { takeWayCode }),
        ...(this.#profile.needTableware !== undefined ? { needTableware: this.#profile.needTableware } : {}) });
      const order = { reference: `order-${randomUUID()}`, plan_hash, candidate_id, session_id: session.id, cart_hash: currentCartHash, status: 'outcome_unknown', total_cents: repriced.price, delivery_cents: repriced.deliveryPrice, attempted_at: new Date(this.#now()).toISOString() };
      this.#state.orders[plan_hash] = order;
      await this.#save(); // Durable fence before the single mutation attempt.
      try {
        const data = officialPayload(await this.#client.callTool('create-order', createArgs, { mutationAuthorized: true })).data;
        if (object(data) && typeof data.orderId === 'string' && data.orderId) order.order_id = data.orderId;
        if (!object(data) || typeof data.orderId !== 'string' || !data.orderId || typeof data.payH5Url !== 'string' || data.orderDetail?.orderStatus !== '待支付') fail('unconfirmed_create_result', '创建结果无法确认，请在本人麦当劳账号核实，禁止重复创建。');
        const url = new URL(data.payH5Url);
        if (url.protocol !== 'https:' || !/(^|\.)(mcd\.cn|mcdchina\.net|mcdonalds\.com\.cn)$/.test(url.hostname)) fail('unconfirmed_payment_url', '支付地址未经官方域名确认，请在本人账号核实。');
        order.payment_url = data.payH5Url;
        order.status = 'awaiting_payment';
        await this.#save();
      } catch { await this.#save(); }
      return this.#publicOrder(order);
    });
  }
  #publicOrder(order) { return { owner_agent_id: this.agent_id, reference: order.reference, order_reference: order.reference, candidate_id: order.candidate_id, status: order.status, total_cents: order.total_cents, delivery_cents: order.delivery_cents ?? 0, paid: order.status === 'completed' }; }
  async localPaymentInfo(reference) {
    await this.#load();
    const order = Object.values(this.#state.orders).find(order => order.reference === reference);
    if (!order) fail('unknown_order_reference', '本机不存在该订单引用。');
    return { ...this.#publicOrder(order), payment_url: order.payment_url ?? null }; // Local CLI only; never post this to coordinator.
  }
  async reconcileLocal({ reference, order_id, explicitOwnerApproval = false, confirmedAbsent = false } = {}) {
    if (explicitOwnerApproval !== true) fail('owner_approval_required', '异常订单须由主人在本机明确核实，不能由协调器自动解除防重。');
    await this.#locked(async () => {
      const order = Object.values(this.#state.orders).find(order => order.reference === reference);
      if (!order) fail('unknown_order_reference', '本机不存在该订单引用。');
      if (confirmedAbsent === true) {
        if (order.status !== 'outcome_unknown' || order.order_id) fail('absence_unconfirmed', '已有明确订单号或非未知状态，不能声明没有订单；请查询其实际状态。');
        order.status = 'owner_confirmed_not_created';
        order.local_review_at = new Date(this.#now()).toISOString();
        order.local_review_source = 'explicit_owner_account_check';
      } else {
        if (!identifier(order_id) || (order.order_id && order.order_id !== order_id)) fail('order_reference_mismatch', '本机订单号不可改绑到其他订单。');
        order.order_id = order_id;
        order.local_review_at = new Date(this.#now()).toISOString();
      }
      await this.#save();
    });
    if (confirmedAbsent === true) { await this.#load(); return this.#publicOrder(Object.values(this.#state.orders).find(order => order.reference === reference)); }
    return this.syncPayment({ reference });
  }
  async syncPayment(input = {}) {
    const reference = typeof input === 'string' ? input : input.reference ?? input.order_reference;
    return this.#locked(async () => {
      const order = Object.values(this.#state.orders).find(order => order.reference === reference);
      if (!order) fail('unknown_order_reference', '本机不存在该订单引用。');
      if (!order.order_id) return this.#publicOrder(order);
      const data = officialPayload(await this.#client.callTool('query-order', await this.#args('query-order', { orderId: order.order_id }))).data;
      if (!object(data) || data.orderId !== order.order_id) fail('unsupported_response_schema', '订单详情与本机创建记录不一致。');
      // Public examples establish completed/cancelled/unpaid strings. Unknown states are not paid.
      if (data.orderStatus === '订单已完成') {
        const actual = yuanToCents(data.realTotalAmount);
        const delivery = yuanToCents(data.realDeliveryPrice);
        order.status = 'completed'; order.total_cents = actual; order.delivery_cents = delivery;
      } else if (data.orderStatus === '订单已取消') order.status = 'cancelled';
      else if (data.orderStatus === '待支付') order.status = 'awaiting_payment';
      else order.status = 'payment_unconfirmed';
      await this.#save();
      return this.#publicOrder(order);
    });
  }
}

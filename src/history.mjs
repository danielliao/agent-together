import { McpError } from './mcp.mjs';

const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const COMBO = /套餐|件套|随心配|分享餐|组合餐|家庭餐/;

/** Redact recognizable personal data before it crosses the member boundary. */
export function publicText(value, max = 100) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC')
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\bBearer\s+\S+|\b(?:sk-|eyJ)[\w.-]+/gi, '[已隐藏]')
    .replace(/(?:\+?86[ -]?)?1[3-9](?:[ -]?\d){9}|\d{7,}/g, '[已隐藏]')
    .replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/_\d{1,6}$/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** These are the public guide's business fields, not inferred aliases. */
export function officialPayload(raw) {
  if (raw?.isError) throw new McpError('tool_error', '官方查询未成功；响应正文已隐藏。');
  const candidates = [raw?.structuredContent, raw];
  for (const block of raw?.content ?? []) if (block?.type === 'text' && typeof block.text === 'string') {
    const text = block.text.trim().replace(/^```(?:json)?\s*\n/i, '').replace(/\n```$/, '');
    try { candidates.push(JSON.parse(text)); } catch { /* Markdown coupon summaries are intentionally not parsed as rules. */ }
  }
  const payload = candidates.find(value => object(value) && Object.hasOwn(value, 'success') && Object.hasOwn(value, 'data'));
  if (!payload) throw new McpError('unsupported_response_schema', '官方响应结构未经确认，未推断内容。');
  if (payload.success !== true || payload.code !== 200) throw new McpError('upstream_error', '官方业务查询未成功；响应正文已隐藏。');
  return payload;
}

export function historyRecords(raw) {
  const data = officialPayload(raw).data;
  if (!object(data) || !Array.isArray(data.list)) throw new McpError('unsupported_response_schema', '历史订单未提供官方 data.list。');
  return data.list.slice(0, 10);
}

export function completedOrder(record) { return record?.orderStatus === '订单已完成'; }
export function unknownOrderStatus(record) { return !['订单已完成', '订单已取消', '待支付'].includes(record?.orderStatus); }

function foodsInOrder(record, depth = 0, child = false) {
  const nodes = child ? record : record?.orderProductList;
  if (depth > 8 || !Array.isArray(nodes)) throw new McpError('unsupported_response_schema', '历史餐品结构未经确认，已停止摘要。');
  const names = [];
  for (const node of nodes) {
    if (!object(node)) throw new McpError('unsupported_response_schema', '历史餐品记录无效。');
    const detailChild = child && Object.hasOwn(node, 'itemName');
    const name = publicText(child ? (detailChild ? node.itemName : node.name) : node.productName);
    const quantity = detailChild ? node.itemQuantity : node.quantity;
    if (!name || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) throw new McpError('unsupported_response_schema', '历史餐品名称或份数未经确认。');
    if (node.comboItemList !== undefined && !Array.isArray(node.comboItemList)) throw new McpError('unsupported_response_schema', '历史套餐子项未经确认。');
    if (node.comboItemList?.length && quantity === 1) names.push(...foodsInOrder(node.comboItemList, depth + 1, true));
    else names.push(name); // Multi-set semantics are unknown; keep the whole combo.
  }
  return names;
}

/** No original SKU, order identifier, store, time, money or delivery field is returned. */
export function summarizeHistory(input, { shared = false } = {}) {
  if (shared !== true) return { shared: false, source: 'withheld', scope: '主人未授权分享近期点餐摘要', foods: [] };
  const records = Array.isArray(input) ? input.slice(0, 10) : historyRecords(input);
  const counts = new Map();
  let sampleSize = 0, excluded = 0, opaqueCombos = 0;
  for (const record of records) {
    if (!completedOrder(record)) { excluded++; continue; }
    const names = foodsInOrder(record);
    if (!names.length) { excluded++; continue; }
    sampleSize++;
    for (const name of new Set(names)) { counts.set(name, (counts.get(name) ?? 0) + 1); if (COMBO.test(name)) opaqueCombos++; }
  }
  return {
    shared: true, source: 'mcp', sample_size: sampleSize, excluded_count: excluded,
    scope: `官方近期最多 10 笔返回记录中的 ${sampleSize} 笔已完成订单；同单同款只算一次出现`,
    foods: [...counts].map(([name, order_count]) => ({ name, order_count })).sort((a, b) => b.order_count - a.order_count || a.name.localeCompare(b.name, 'zh-CN')),
    ...(opaqueCombos ? { warnings: ['部分套餐组成或多份套餐子项份数不明，保留套餐整体；不能由历史餐品直接重建当前可下单 SKU。'] } : {}),
  };
}

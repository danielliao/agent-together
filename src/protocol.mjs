import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class TogetherError extends Error {
  constructor(code,message,status=400){super(message);this.code=code;this.status=status;}
}
export const assert=(test,code,message,status)=>{if(!test)throw new TogetherError(code,message,status);};
export const secret=()=>randomBytes(24).toString('base64url');
export const sameSecret=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function canonical(value){
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const clone=value=>JSON.parse(JSON.stringify(value));
export function label(value,max=100){
  assert(typeof value==='string','INVALID_LABEL','名称必须是文字。');
  return value.normalize('NFKC').replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\bBearer\s+\S+|\d{7,}/gi,'[已隐藏]').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
}
export function cents(v){assert(Number.isSafeInteger(v)&&v>=0&&v<=100000000,'INVALID_MONEY','金额必须是非负整数分。');return v;}
export function identifier(v){assert(typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(v)&&!/^eyJ|^sk-/i.test(v),'INVALID_ID','标识格式不正确。');return v;}
function modification(v){assert(v&&Array.isArray(v.values)&&v.values.length<=50,'INVALID_CONFIGURATION','特制配置未确认。');return {values:v.values.map(x=>({code:identifier(String(x.code)),quantity:cents(x.quantity),key:identifier(x.key)}))};}
export function safeSnapshot(input,identity){
  assert(input.agent_id===identity.agent_id,'WRONG_IDENTITY','成员身份不匹配。',403);
  assert(Array.isArray(input.options)&&input.options.length>0&&input.options.length<=4,'INVALID_OPTIONS','每人需要 1–4 个自己接受的配置。');
  const options=input.options.map(o=>({id:identifier(o.id),label:label(o.label),price_cents:cents(o.price_cents),items:o.items.map(i=>{
    assert(Number.isSafeInteger(i.quantity)&&i.quantity>0&&i.quantity<=50,'INVALID_QUANTITY','餐品数量不正确。');
    const out={sku:identifier(i.sku),name:label(i.name),quantity:i.quantity};
    if(i.unit_price_cents!==undefined)out.unit_price_cents=cents(i.unit_price_cents);
    // Keep only declared configuration fields, never arbitrary nested account data.
    if(i.modification!==undefined)out.modification=modification(i.modification);
    if(i.roundList!==undefined){assert(Array.isArray(i.roundList)&&i.roundList.length<=20,'INVALID_CONFIGURATION','套餐配置未确认。');out.roundList=i.roundList.map(g=>{assert(Array.isArray(g.comboItemList)&&g.comboItemList.length<=50,'INVALID_CONFIGURATION','套餐分组未确认。');return {round:typeof g.round==='number'?cents(g.round):identifier(g.round),comboItemList:g.comboItemList.map(x=>({code:identifier(String(x.code)),quantity:cents(x.quantity),...(x.modification?{modification:modification(x.modification)}:{})}))};});}
    return out;
  })}));
  const account=input.account;
  assert(account&&account.context,'INVALID_ACCOUNT','缺少当前门店和就餐范围。');
  for(const k of ['snapshot_at','expires_at'])assert(typeof account[k]==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(account[k])&&Number.isFinite(Date.parse(account[k])),'INVALID_SNAPSHOT_TIME','权益快照时间格式未确认。');
  const rules=xs=>(xs??[]).map(r=>{
    assert(r&&typeof r==='object'&&!Array.isArray(r),'INVALID_RULE','优惠规则格式不正确。');
    const out={known:r.known===true};
    if(r.type!==undefined){assert(['fixed','percent','delivery_waived','item_fixed','points','unknown'].includes(r.type),'INVALID_RULE_TYPE','优惠类型未经确认。');out.type=r.type;}
    for(const k of ['stackable','uses_points'])if(r[k]!==undefined){assert(typeof r[k]==='boolean','INVALID_RULE','优惠标记格式不正确。');out[k]=r[k];}
    if(r.group!==undefined)out.group=identifier(r.group);
    for(const k of ['available_count','min_food_cents','min_quantity','amount_cents','discount_bps','max_discount_cents','max_quantity','points_cost','cash_cost_cents'])if(r[k]!==undefined)out[k]=cents(r[k]);
    for(const k of ['valid_from','expires_at'])if(r[k]!==undefined){assert(typeof r[k]==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r[k])&&Number.isFinite(Date.parse(r[k])),'INVALID_RULE_TIME','优惠有效期格式未确认。');out[k]=r[k];}
    for(const k of ['store_ids','service_modes','fulfillment_keys','eligible_skus'])if(r[k]!==undefined){const v=r[k];assert(v==='*'||(Array.isArray(v)&&v.length<=100),'INVALID_RULE_SCOPE','优惠适用范围格式未确认。');out[k]=v==='*'?'*':v.map(x=>x==='*'?'*':identifier(x));}
    out.id=identifier(r.id);out.name=label(r.name??r.id);out.summary=label(r.summary??'以本人账号核价为准',160);
    if(r.quote_only===true&&r.binding_summary?.owner_confirmed===true){const b=r.binding_summary;out.quote_only=true;out.binding_summary={agent_id:identifier(b.agent_id),option_id:identifier(b.option_id),item_index:cents(b.item_index),base_sku:identifier(b.base_sku),product_sku:identifier(b.product_sku),owner_confirmed:true};out.product_skus=(r.product_skus??[]).map(identifier);}
    return out;
  });
  assert((account.coupons??[]).length+(account.benefits??[]).length<=8,'TOO_MANY_RULES','每个账号最多收集 8 条明确规则，更多券请先由主人筛选。');
  const output={agent_id:identity.agent_id,name:label(input.name??identity.name),budget_cents:cents(input.budget_cents),options,
    account:{eligible_to_order:account.eligible_to_order===true,delivery_fee_cents:cents(account.delivery_fee_cents??0),context:{store_id:identifier(account.context.store_id),service_mode:identifier(account.context.service_mode),fulfillment_key:identifier(account.context.fulfillment_key)},snapshot_at:account.snapshot_at,expires_at:account.expires_at,coupons:rules(account.coupons),benefits:rules(account.benefits)}};
  if(input.max_pay_cents!==undefined)output.max_pay_cents=cents(input.max_pay_cents);
  if(account.coupon_selection_note){const n=account.coupon_selection_note;output.account.coupon_selection_note={available_count:cents(n.available_count),shared_count:cents(n.shared_count),complete:n.complete===true,scope:['owner_selected','limited_summary'].includes(n.scope)?n.scope:'limited_summary',note:label(n.note??'本次仅比较主人选择的可匹配候选券。',160)};}
  const h=input.history;
  output.history=h?.shared===true?{shared:true,source:h.source==='mcp'?'mcp':'imported',completed_order_count:cents(h.completed_order_count??h.sample_size??0),excluded_order_count:cents(h.excluded_order_count??h.excluded_count??0),period_label:label(h.period_label??h.scope??'接口近期样本',160),favorites:(h.favorites??h.foods??[]).slice(0,8).map(f=>({name:label(f.name),count:cents(f.count??f.order_count)}))}:{shared:false,source:'private',favorites:[]};
  return output;
}

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { optimizeSession, enumerateCandidates, allocateBills } from './optimizer.mjs';
import { assert, clone, digest, secret, identifier, label, cents, safeSnapshot, TogetherError } from './protocol.mjs';

const now=()=>new Date().toISOString();
const fresh=t=>Number.isFinite(Date.parse(t))&&Date.parse(t)>Date.now();
const affordable=(p,b)=>b.every(x=>{const person=p.find(y=>y.agent_id===x.agent_id);return x.payable_cents<=person.budget_cents&&x.payable_cents<=(person.max_pay_cents??Infinity);});

export class Coordinator {
  constructor(){this.session=null;this.plan=null;this.events=[];this.outbox=[];this.identities=new Map();this.tasks=new Map();this.retiredTasks=new Map();this.results=new Map();this.demo=false;this.checkoutStarted=false;}
  event(type,message,agent_id){this.events.push({id:randomUUID(),type,message,time:now(),...(agent_id?{agent_id}:{})});}
  clear(){this.session=null;this.plan=null;this.events=[];this.outbox=[];this.identities.clear();this.tasks.clear();this.retiredTasks.clear();this.results.clear();this.checkoutStarted=false;}
  state(){return clone({session:this.session,plan:this.plan,events:this.events.slice(-80),outbox:this.outbox.map(({payload,...summary})=>summary),demo:this.demo,settlement:this.session?.status==='settled'?{participant_bills:this.plan.best.participant_bills,actual_total_cents:this.session.receipt.total_cents,payer_agent_id:this.plan.best.owner_agent_id,source:this.demo?'demo':'mcp'}:null,capabilities:{live_checkout:!this.demo&&!this.checkoutStarted&&this.plan?.status==='verified'&&fresh(this.plan.best.expires_at)&&this.session.participants.every(p=>fresh(p.account.expires_at)),payment_transfer:false}});}
  create(input){
    assert(!this.checkoutStarted||this.session?.status==='settled','ORDER_IN_PROGRESS','已发出下单请求；请先核对订单，不可重置。',409);
    this.clear();this.demo=false;
    assert(Array.isArray(input.participants)&&input.participants.length>=2&&input.participants.length<=8,'INVALID_MEMBERS','拼单人数为 2–8 人。');
    const ids=new Set();
    this.session={id:randomUUID(),status:'collecting',store_id:identifier(input.store_id),service_mode:input.service_mode,fulfillment_key:identifier(input.fulfillment_key),at:now(),split_policy:input.split_policy??'proportional',participants:input.participants.map(p=>{
      const id=identifier(p.agent_id);assert(!ids.has(id),'DUPLICATE_MEMBER','Agent 标识不可重复。');ids.add(id);
      const member={agent_id:id,name:label(p.name),status:'invited'};this.identities.set(id,{...member,secret:secret()});return member;
    })};
    assert(['pickup','delivery'].includes(this.session.service_mode),'INVALID_SERVICE','选择到店取餐或麦乐送。');
    assert(['proportional','equal'].includes(this.session.split_policy),'INVALID_SPLIT','分账模式不正确。');
    this.event('session','发起人邀请各成员 Agent，等待本人需求与可共享摘要。');
    return [...this.identities.values()].map(p=>({agent_id:p.agent_id,secret:p.secret,session_id:this.session.id}));
  }
  async loadDemo(scenario='office'){
    assert(!this.checkoutStarted||this.session?.status==='settled','ORDER_IN_PROGRESS','已有未核对订单，不能清空。',409);
    const data=JSON.parse(await readFile(new URL('../examples/office.json',import.meta.url),'utf8'));
    this.clear();this.demo=true;this.demoInput=data;
    data.id=randomUUID();data.at=now();
    for(const p of data.participants){p.account.snapshot_at=now();p.account.expires_at=new Date(Date.now()+3600000).toISOString();for(const r of [...p.account.coupons,...p.account.benefits])r.expires_at=new Date(Date.now()+3600000).toISOString();}
    if(scenario==='expired'){const bestOwner=data.participants[1];for(const r of [...bestOwner.account.coupons,...bestOwner.account.benefits])r.expires_at=new Date(Date.now()-1000).toISOString();}
    if(scenario==='budget')for(const p of data.participants)p.budget_cents=100;
    const favorites=[['巨无霸','中薯条'],['麦香鱼','玉米杯'],['麦香鸡','无糖可乐'],['板烧鸡腿堡','美式咖啡']];
    data.participants.forEach((p,i)=>{p.history??={shared:true,source:'demo',completed_order_count:6,excluded_order_count:1,period_label:'虚构近期 6 笔已完成订单',favorites:[{name:favorites[i][0],count:4},{name:favorites[i][1],count:3}]};this.identities.set(p.agent_id,{agent_id:p.agent_id,name:p.name,secret:secret()});});
    this.session={...clone(data),status:'collecting',participants:data.participants.map(p=>({agent_id:p.agent_id,name:p.name,status:'invited'}))};
    this.event('session','四位虚构 Agent 已入座，等待收集近期偏好、需求和各自权益。');return this.state();
  }
  invalidate(){assert(!this.checkoutStarted,'ORDER_IN_PROGRESS','下单已发出，不能改动需求。',409);this.plan=null;this.results.clear();this.retireTasks(t=>t.type!=='collect');this.session.status='collecting';for(const p of this.session.participants)delete p.approval;}
  snapshot(agentId,input){
    assert(this.session,'NO_SESSION','请先发起拼单。',409);this.invalidate();
    const identity=this.identities.get(agentId);assert(identity,'UNKNOWN_AGENT','成员不存在。',403);
    const snap=safeSnapshot(input,identity);
    assert(snap.account.context.store_id===this.session.store_id&&snap.account.context.service_mode===this.session.service_mode&&snap.account.context.fulfillment_key===this.session.fulfillment_key,'CONTEXT_MISMATCH','门店、取餐方式或收货目标不一致，不能放在同一单。');
    assert(fresh(snap.account.expires_at),'STALE_SNAPSHOT','权益快照已过期，请成员重新收集。');
    const index=this.session.participants.findIndex(p=>p.agent_id===agentId);this.session.participants[index]={...snap,status:'collected',request:{summary:snap.options.map(o=>o.label).join(' / '),budget_cents:snap.budget_cents}};
    if(this.session.participants.every(p=>p.status==='collected'))this.session.status='ready';
    this.event('collected',`${snap.name}：${snap.history.shared?'已共享近期偏好摘要':'历史保持私密'}，已提交本人接受的餐品与账号权益。`,agentId);return this.state();
  }
  async collect(){
    assert(this.session,'NO_SESSION','请先发起拼单。',409);
    assert(!this.checkoutStarted,'ORDER_IN_PROGRESS','下单已发出，不能重新收集。',409);
    if(this.demo){for(const p of this.demoInput.participants){const safe={...clone(p),history:{...p.history,source:'imported'}};this.snapshot(p.agent_id,safe);this.session.participants.find(x=>x.agent_id===p.agent_id).history.source='demo';}return this.state();}
    if(this.session.participants.some(p=>p.status==='collecting'))return this.state();
    this.invalidate();for(const p of this.session.participants)p.status='collecting';
    for(const p of this.session.participants)this.queue(p.agent_id,'collect',{session_id:this.session.id,context:{store_id:this.session.store_id,service_mode:this.session.service_mode,fulfillment_key:this.session.fulfillment_key}});
    this.event('collect_requested','已向每位成员自己的 Agent 发出收集请求；等待各人本机回复。');return this.state();
  }
  ensureReady(){assert(this.session&&this.session.participants.every(p=>p.status==='collected'),'NOT_COLLECTED','需要全员提交需求、当前权益范围和历史分享选择。',409);assert(this.session.participants.every(p=>fresh(p.account.expires_at)),'STALE_SNAPSHOT','成员权益快照已过期，请重新收集。',409);}
  optimize(){
    this.ensureReady();assert(!this.checkoutStarted,'ORDER_IN_PROGRESS','已有下单请求。',409);this.session.at=now();this.results.clear();this.retireTasks(()=>true);
    if(this.demo){const computed=optimizeSession(this.session);assert(computed.best,'NO_FEASIBLE_PLAN','没有满足所有人预算的拼单方案；请调整本人需求或预算。',422);this.setPlan(computed,'estimate');this.event('optimized',`已精确比较 ${computed.audit.combinations_evaluated} 个虚构候选，选出下单 Agent。`);}
    else{
      const candidates=enumerateCandidates(this.session,{maxEvaluations:200});assert(candidates.length,'NO_CANDIDATES','没有可核价的候选。',422);
      // Unknown discount amounts may be probed one coupon at a time when its concrete
      // product binding is explicitly known. Never invent stacking or threshold rules.
      for(const base of [...candidates].filter(c=>c.coupon_ids.length===0&&c.benefit_ids.length===0)){
        const owner=this.session.participants.find(p=>p.agent_id===base.owner_agent_id);
        for(const coupon of owner.account.coupons.filter(r=>r.known!==true&&r.quote_only===true)){
          const b=coupon.binding_summary;const person=this.session.participants.find(p=>p.agent_id===b.agent_id);const selected=person?.options.find(o=>o.id===base.option_ids[b.agent_id]);
          if(!selected||selected.id!==b.option_id||selected.items[b.item_index]?.sku!==b.base_sku||!coupon.product_skus.includes(b.product_sku))continue;
          candidates.push({...clone(base),coupon_ids:[coupon.id],coupon_replacements:[clone(b)]});
        }
      }
      assert(candidates.length<=200,'EXACT_CAP_EXCEEDED','真实候选超过 200 个，请主人收窄可接受配置或筛选需要比较的券。',422);
      this.liveCandidates=new Map();for(const c of candidates){const id=digest({session_id:this.session.id,candidate:c}).slice(0,24);this.liveCandidates.set(id,c);this.queue(c.owner_agent_id,'quote',{candidate_id:id,candidate:this.executionCandidate(c),session:this.orderContext()});}
      this.plan={status:'quoting',pending_quotes:candidates.length,warnings:['真实核价覆盖本次主人允许的配置及可明确匹配的卡券；未识别规则不宣称全平台最优。'],candidates:[]};this.session.status='quoting';this.event('quote_requested',`已发送 ${candidates.length} 个候选到各账号自己的 Agent 核价。`);
    }
    return this.state();
  }
  setPlan(computed,status){
    const best=computed.best;
    const payer=this.session.participants.find(p=>p.agent_id===best.owner_agent_id);
    best.coupon_replacements??=(payer.account.coupons??[]).filter(c=>best.coupon_ids.includes(c.id)&&c.binding_summary).map(c=>clone(c.binding_summary));
    const plan_hash=digest({session_id:this.session.id,session_at:this.session.at,participants:this.session.participants,best});
    this.plan={...computed,status,plan_hash,candidates:(computed.account_candidates??[]).map(x=>({owner_agent_id:x.owner_agent_id,total_cents:x.best?.total_cents??null,reason:x.reason??null})),approved_agent_ids:[],warnings:computed.warnings??[]};
    for(const p of this.session.participants)delete p.approval;this.session.status='planned';
    for(const p of this.session.participants)this.queue(p.agent_id,'proposal',{plan_hash,bill:best.participant_bills.find(x=>x.agent_id===p.agent_id),owner_agent_id:best.owner_agent_id,total_cents:best.total_cents,option_id:best.option_ids[p.agent_id],selected_option:clone(p.options.find(o=>o.id===best.option_ids[p.agent_id])),coupon_replacements:(best.coupon_replacements??[]).filter(b=>b.agent_id===p.agent_id),status,expires_at:best.expires_at??p.account.expires_at});
  }
  approve(agentId,planHash,{demo=false}={}){
    assert(this.plan?.best&&this.plan.plan_hash===planHash,'STALE_PLAN','方案已改变，确认失效。',409);
    const reconciliation=this.plan.reconciliation===true;
    assert(this.demo?demo:(reconciliation?this.plan.status==='receipt_verified':this.plan.status==='verified'),'UNVERIFIED_PRICE','需要完整核价或已核实支付收据。',409);
    assert(reconciliation?this.session.status==='reconciliation_proposed':(this.session.status==='planned'||this.session.status==='approved'),'INVALID_STATE','当前阶段不能确认。',409);
    if(!reconciliation){this.ensureReady();if(!this.demo)assert(fresh(this.plan.best.expires_at),'QUOTE_EXPIRED','核价已过期，请重新比价。',409);}
    const person=this.session.participants.find(p=>p.agent_id===agentId);assert(person,'UNKNOWN_AGENT','成员不存在。',403);
    person.approval={approved:true,plan_hash:planHash,at:now(),...(this.demo?{simulated:true}:{})};
    this.plan.approved_agent_ids=this.session.participants.filter(p=>p.approval?.plan_hash===planHash).map(p=>p.agent_id);
    if(this.plan.approved_agent_ids.length===this.session.participants.length){if(reconciliation)this.finalizeSettlement(this.session.receipt.total_cents,this.session.receipt.delivery_cents,this.plan.best.participant_bills);else this.session.status='approved';}
    this.event('approved',`${person.name} 的${this.demo?'模拟主人':'主人'}已确认自己的餐品、分摊金额和下单账号。`,agentId);return this.state();
  }
  checkout(planHash){
    assert(this.plan?.reconciliation!==true,'ALREADY_PAID','订单已支付，此方案仅确认分账，不再次下单。',409);
    assert(!this.checkoutStarted,'DUPLICATE_CHECKOUT','下单请求已经发出，不能再次提交。',409);
    assert(this.plan?.plan_hash===planHash&&this.session.status==='approved','APPROVAL_REQUIRED','需要全员确认同一份当前方案。',409);this.ensureReady();
    assert(this.demo||fresh(this.plan.best.expires_at),'QUOTE_EXPIRED','核价已过期。',409);
    this.checkoutStarted=true;this.session.status=this.demo?'awaiting_payment':'submitting';
    const owner=this.plan.best.owner_agent_id;
    if(this.demo){this.session.order={source:'demo',reference:`demo-${this.session.id.slice(0,8)}`,status:'awaiting_payment'};this.event('order',`模拟订单交给 ${this.session.participants.find(p=>p.agent_id===owner).name} 的 Agent。没有创建真实订单。`,owner);}
    else{this.queue(owner,'checkout',{candidate_id:this.plan.best.candidate_id,candidate:this.executionCandidate(this.plan.best),plan_hash:planHash,session:{...this.orderContext(),plan_hash:planHash},approval_receipts:this.session.participants.map(p=>({agent_id:p.agent_id,...p.approval}))});this.event('checkout_requested','已把全员确认回执交给当选 Agent。由该 Agent 在自己的账号复核价格并提交一次。',owner);}
    return this.state();
  }
  queue(agentId,type,payload){const queue=this.tasks.get(agentId)??[];if(['collect','payment'].includes(type)){const existing=queue.find(t=>t.type===type);if(existing)return existing;}const task={id:randomUUID(),type,payload};queue.push(task);this.tasks.set(agentId,queue);return task;}
  retireTasks(predicate){for(const [id,q] of this.tasks){for(const t of q.filter(predicate))this.retiredTasks.set(t.id,id);this.tasks.set(id,q.filter(t=>!predicate(t)));}while(this.retiredTasks.size>5000)this.retiredTasks.delete(this.retiredTasks.keys().next().value);}
  orderContext(){return clone({id:this.session.id,store_id:this.session.store_id,service_mode:this.session.service_mode,fulfillment_key:this.session.fulfillment_key,at:this.session.at,split_policy:this.session.split_policy,participants:this.session.participants.map(p=>({agent_id:p.agent_id,name:p.name,options:p.options}))});}
  executionCandidate(c){return clone(Object.fromEntries(['owner_agent_id','option_ids','coupon_ids','benefit_ids','total_cents','delivery_cents','candidate_id','coupon_replacements'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]])));}
  getTasks(agentId){return clone({tasks:(this.tasks.get(agentId)??[]).slice(0,20)});}
  acknowledge(agentId,taskId){const queue=this.tasks.get(agentId)??[];if(queue.some(t=>t.id===taskId))this.retiredTasks.set(taskId,agentId);this.tasks.set(agentId,queue.filter(t=>t.id!==taskId));}
  result(agentId,{task_id,result,error}){
    const task=(this.tasks.get(agentId)??[]).find(t=>t.id===task_id);if(!task&&this.retiredTasks.get(task_id)===agentId)return this.state();assert(task,'UNKNOWN_TASK','任务不存在或已经确认。',409);
    this.acknowledge(agentId,task_id);
    if(task.type==='collect'){if(error){this.session.participants.find(p=>p.agent_id===agentId).status='collection_failed';this.event('error','成员收集失败，请在其本机校准接口或重新连接。',agentId);return this.state();}return this.snapshot(agentId,result);}
    if(task.type==='quote'){
      this.results.set(task.payload.candidate_id,error?{error:true}:{result});
      if(this.results.size===this.liveCandidates.size)this.completeQuotes();else if(this.plan)this.plan.pending_quotes=this.liveCandidates.size-this.results.size;
    }else if(task.type==='checkout'){
      if(error){this.session.status='order_uncertain';this.event('error','下单结果未确认；保持提交锁，须当选 Agent 查询订单，不能自动重试。',agentId);}
      else if(result?.status==='PRICE_CHANGED'){this.checkoutStarted=false;this.invalidate();this.session.status='ready';this.event('price_changed','提交前复核发现变价，没有创建订单。全部确认失效，请重新核价。',agentId);}
      else if(result?.status==='awaiting_payment'){this.session.order={source:'mcp',reference:identifier(result.reference??result.order_reference),status:'awaiting_payment'};this.session.status='awaiting_payment';this.event('order','当选账号已创建待支付订单。支付链接留在当选 Agent 本机，请主人完成支付。',agentId);}
      else{this.session.status='order_uncertain';this.event('error','创建结果尚未明确，保留提交锁。请当选 Agent 核对本人订单后处理。',agentId);}
    }else if(task.type==='payment'){
      if(error||result?.paid!==true){this.event('payment_pending','尚未收到已支付状态，不生成正式应收账单。',agentId);}else this.finishSettlement(cents(result.total_cents),cents(result.delivery_cents));
    }else if(task.type==='bill'){
      const envelope=this.outbox.find(x=>x.id===task.payload.envelope_id);if(envelope){envelope.status=error?'delivery_failed':'delivered';this.event('bill_delivered',error?'账单送达失败，可重新领取。':'本人 Agent 已确认收到账单。',agentId);}
    }
    return this.state();
  }
  completeQuotes(){
    const all=[];let failures=0;
    for(const [id,candidate] of this.liveCandidates){const received=this.results.get(id);const quote=received?.result;if(received?.error||quote?.verified!==true||quote.candidate_id!==id||quote.owner_agent_id!==candidate.owner_agent_id||!fresh(quote.expires_at)||!Number.isFinite(Date.parse(quote.quoted_at))||Date.parse(quote.quoted_at)>Date.now()){failures++;continue;}
      const total=cents(quote.total_cents),delivery=cents(quote.delivery_cents);assert(delivery<=total,'BAD_QUOTE','配送费大于总价。');
      const bills=allocateBills({participants:this.session.participants,option_ids:candidate.option_ids,total_cents:total,delivery_cents:delivery,split_policy:this.session.split_policy});
      all.push({...candidate,candidate_id:id,total_cents:total,food_cents:bills.reduce((s,b)=>s+b.food_cents,0),discount_cents:bills.reduce((s,b)=>s+b.discount_cents,0),delivery_cents:delivery,participant_bills:bills,status:'verified',expires_at:quote.expires_at,quoted_at:quote.quoted_at,estimate_budget_feasible:affordable(this.session.participants,bills)});
    }
    if(failures){this.plan={status:'quote_incomplete',exact:false,pending_quotes:0,candidates:all.map(c=>({owner_agent_id:c.owner_agent_id,total_cents:c.total_cents})),warnings:[`${failures} 个候选核价失败或已过期；不能确认真实最优价，请重新收集或收窄明确接受的配置后重算。`]};this.session.status='quote_incomplete';return;}
    const feasible=all.filter(c=>c.estimate_budget_feasible).sort((a,b)=>a.total_cents-b.total_cents||digest(a).localeCompare(digest(b)));assert(feasible.length,'NO_FEASIBLE_PLAN','核价后没有全员预算内方案。',422);
    const account_candidates=this.session.participants.map(p=>({owner_agent_id:p.agent_id,best:feasible.find(c=>c.owner_agent_id===p.agent_id)??null}));
    this.setPlan({best:feasible[0],exact:true,account_candidates,audit:{combinations_evaluated:all.length},solo_baseline:null,savings_cents:null,warnings:['最优仅限本次明确允许的餐品配置、已匹配卡券和同一履约范围。未识别券规则没有被假定可叠加。']},'verified');this.event('quotes_verified','全部候选完成本人账号实时核价，已按实际实付选出下单 Agent。');
  }
  requestPayment(){assert(!this.demo&&this.session?.status==='awaiting_payment','INVALID_STATE','需要已创建的真实待支付订单。',409);this.queue(this.plan.best.owner_agent_id,'payment',{reference:this.session.order.reference,order_reference:this.session.order.reference,plan_hash:this.plan.plan_hash});return this.state();}
  settle(total){assert(this.demo,'LIVE_RECEIPT_REQUIRED','真实支付状态必须由当选账号 query-order 核验，不能手填已支付。',403);assert(this.session?.status==='awaiting_payment','INVALID_STATE','请先模拟创建待支付订单。',409);this.finishSettlement(total===undefined?this.plan.best.total_cents:cents(total),this.plan.best.delivery_cents);return this.state();}
  finishSettlement(total,delivery){
    assert(this.session?.status==='awaiting_payment','INVALID_STATE','当前不是待支付阶段。',409);
    const bills=allocateBills({participants:this.session.participants,option_ids:this.plan.best.option_ids,total_cents:total,delivery_cents:delivery,split_policy:this.session.split_policy});
    this.session.order.status='paid';
    if(total!==this.plan.best.total_cents||delivery!==this.plan.best.delivery_cents){this.session.status='reconciliation_required';this.session.receipt={total_cents:total,delivery_cents:delivery};this.event('price_changed','实付与全员确认的报价不同，请核对差额并重新同意分账；未自动发送新的应收金额。');return;}
    assert(affordable(this.session.participants,bills),'BUDGET_EXCEEDED','实付分账超过成员预算。',409);
    this.finalizeSettlement(total,delivery,bills);
  }
  proposeReconciliation(){
    assert(this.session?.status==='reconciliation_required'&&this.session.order?.status==='paid','INVALID_STATE','需要已核验支付且存在报价差额。',409);
    const {total_cents:total,delivery_cents:delivery}=this.session.receipt;
    const bills=allocateBills({participants:this.session.participants,option_ids:this.plan.best.option_ids,total_cents:total,delivery_cents:delivery,split_policy:this.session.split_policy});
    assert(affordable(this.session.participants,bills),'BUDGET_EXCEEDED','新的分账超过成员预算或硬上限，不能强制 AA；请主人自行协商处理差额。',409);
    this.retireTasks(()=>true);this.plan.original_quote_cents??=this.plan.best.total_cents;
    this.plan.best={...this.plan.best,total_cents:total,delivery_cents:delivery,food_cents:bills.reduce((s,b)=>s+b.food_cents,0),discount_cents:bills.reduce((s,b)=>s+b.discount_cents,0),participant_bills:bills,status:'receipt_verified'};
    this.plan.reconciliation=true;this.plan.status='receipt_verified';this.plan.exact=false;this.plan.plan_hash=digest({purpose:'paid-receipt-aa',session_id:this.session.id,previous_plan_hash:this.plan.plan_hash,receipt:this.session.receipt,bills});this.plan.approved_agent_ids=[];
    this.session.status='reconciliation_proposed';for(const p of this.session.participants){delete p.approval;this.queue(p.agent_id,'proposal',{plan_hash:this.plan.plan_hash,bill:bills.find(b=>b.agent_id===p.agent_id),owner_agent_id:this.plan.best.owner_agent_id,total_cents:total,selected_option:clone(p.options.find(o=>o.id===this.plan.best.option_ids[p.agent_id])),status:'receipt_verified',settlement_only:true,expires_at:new Date(Date.now()+86400000).toISOString()});}
    this.event('reconciliation_proposed','已按核验实付提出新账单，等待全员确认；不会创建第二张订单。');return this.state();
  }
  finalizeSettlement(total,delivery,bills){
    this.session.status='settled';this.session.order.status='paid';this.session.receipt={total_cents:total,delivery_cents:delivery};this.plan.best.participant_bills=bills;
    const payer=this.plan.best.owner_agent_id;
    for(const bill of bills){const id= randomUUID();const envelope={id,agent_id:bill.agent_id,type:'aa_bill',status:this.demo?'delivered':'queued',message:`${bill.name} 本次应付 ${(bill.payable_cents/100).toFixed(2)} 元${bill.agent_id===payer?'，已由本人垫付':'，转给下单主人'}`,payload:{envelope_id:id,session_id:this.session.id,plan_hash:this.plan.plan_hash,payer_agent_id:payer,bill,source:this.demo?'demo':'mcp',payment_status:'paid',transfer_status:'untracked',amount_to_transfer_cents:bill.agent_id===payer?0:bill.payable_cents,total_cents:total}};this.outbox.push(envelope);if(!this.demo)this.queue(bill.agent_id,'bill',envelope.payload);}
    this.event('settled',`正式分账合计 ${(total/100).toFixed(2)} 元，逐分等于${this.demo?'模拟':'官方'}实付；${this.demo?'四位模拟 Agent 已确认收到账单':'等待各 Agent 确认收到本人账单'}。`);
  }
  exportBills(){assert(this.session?.status==='settled','NO_FINAL_BILL','订单已支付并核对金额后才有正式账单。',409);return clone({project:'agent-together',source:this.demo?'demo':'mcp',session_id:this.session.id,plan_hash:this.plan.plan_hash,payer_agent_id:this.plan.best.owner_agent_id,total_cents:this.session.receipt.total_cents,bills:this.plan.best.participant_bills,transfer_status:'untracked',invariant:'sum(payable_cents) === total_cents'});}
}

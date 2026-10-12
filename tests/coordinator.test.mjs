import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator.mjs';
import { safeSnapshot } from '../src/protocol.mjs';
import { startServer } from '../src/server.mjs';

const ready=async()=>{const c=new Coordinator();await c.loadDemo();await c.collect();c.optimize();return c;};
test('four independent members collect preferences, elect payer, confirm, settle and receive conserving bills',async()=>{
  const c=await ready();assert.equal(c.session.participants.length,4);assert.ok(c.session.participants.every(p=>p.history.source==='demo'));
  assert.ok(c.plan.best.owner_agent_id);assert.throws(()=>c.checkout(c.plan.plan_hash),/全员确认/);
  for(const p of c.session.participants)c.approve(p.agent_id,c.plan.plan_hash,{demo:true});
  c.checkout(c.plan.plan_hash);assert.throws(()=>c.exportBills(),/正式账单/);assert.throws(()=>c.checkout(c.plan.plan_hash),/已经发出/);
  c.settle();const bill=c.exportBills();assert.equal(bill.bills.reduce((a,b)=>a+b.payable_cents,0),bill.total_cents);assert.equal(c.outbox.length,4);assert.ok(c.outbox.every(x=>x.status==='delivered'));
  for(const x of c.outbox)assert.equal(x.payload.bill.agent_id,x.agent_id);
});
test('changing member needs invalidates all approvals and prior plan hash',async()=>{
  const c=await ready();const hash=c.plan.plan_hash;c.approve(c.session.participants[0].agent_id,hash,{demo:true});
  const p=structuredClone(c.demoInput.participants[0]);p.options=p.options.slice(0,1);c.snapshot(p.agent_id,p);assert.equal(c.plan,null);c.optimize();assert.notEqual(c.plan.plan_hash,hash);assert.throws(()=>c.approve(p.agent_id,hash,{demo:true}),/确认失效/);
});
test('actual paid amount drift stops AA demands rather than silently increasing everyone',async()=>{
  const c=await ready();for(const p of c.session.participants)c.approve(p.agent_id,c.plan.plan_hash,{demo:true});c.checkout(c.plan.plan_hash);c.settle(c.plan.best.total_cents+1);assert.equal(c.session.status,'reconciliation_required');assert.equal(c.outbox.length,0);
});
test('a verified paid difference gets a new AA approval round and never creates a second order',async()=>{
  const c=await ready();const old=c.plan.plan_hash;for(const p of c.session.participants)c.approve(p.agent_id,old,{demo:true});c.checkout(old);c.settle(c.plan.best.total_cents+1);
  assert.equal(c.session.order.status,'paid');for(const p of c.session.participants)p.account.expires_at='2020-01-01T00:00:00Z';
  c.proposeReconciliation();assert.equal(c.session.status,'reconciliation_proposed');assert.notEqual(c.plan.plan_hash,old);assert.equal(c.plan.approved_agent_ids.length,0);assert.throws(()=>c.checkout(c.plan.plan_hash),/不再次下单/);
  for(const p of c.session.participants)c.approve(p.agent_id,c.plan.plan_hash,{demo:true});assert.equal(c.session.status,'settled');assert.equal(c.outbox.length,4);assert.equal(c.exportBills().bills.reduce((s,b)=>s+b.payable_cents,0),6721);
});
test('paid reconciliation cannot quietly relax a participant financial cap',async()=>{
  const c=await ready();for(const p of c.session.participants)c.approve(p.agent_id,c.plan.plan_hash,{demo:true});c.checkout(c.plan.plan_hash);c.settle(c.plan.best.total_cents+100000);assert.throws(()=>c.proposeReconciliation(),/不能强制 AA/);assert.equal(c.outbox.length,0);
});
test('snapshot sharing strips private orders, addresses, bearer and raw coupon codes',async()=>{
  const c=await ready();const p=structuredClone(c.demoInput.participants[0]);p.token='DO_NOT_SHARE';p.orderId='DO_NOT_SHARE';p.address='DO_NOT_SHARE';p.account.coupons.push({id:'private-coupon-fixture',name:'测试券',known:false,couponCode:'DO_NOT_SHARE'});p.history.orders=[{address:'DO_NOT_SHARE'}];
  const snapshot=safeSnapshot(p,{agent_id:p.agent_id,name:p.name});assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_SHARE'));
  p.history.shared=false;const privateHistory=safeSnapshot(p,{agent_id:p.agent_id,name:p.name}).history;assert.deepEqual(privateHistory.favorites,[]);
  p.account.coupons[0].group='Bearer SYNTHETIC_FAKE_PRIVATE_TOKEN';assert.throws(()=>safeSnapshot(p,{agent_id:p.agent_id,name:p.name}),/标识格式/);
});

async function liveReady(){const c=new Coordinator();await c.loadDemo();const input=structuredClone(c.demoInput.participants);c.demo=false;for(const p of input){p.options=p.options.slice(0,1);p.account.coupons=[];p.account.benefits=[];c.snapshot(p.agent_id,p);}return c;}
test('one incomplete or crossed quote prevents any verified best or checkout',async()=>{
  const c=await liveReady();c.optimize();for(const p of c.session.participants)for(const task of c.getTasks(p.agent_id).tasks){if(task.type!=='quote')continue;c.result(p.agent_id,{task_id:task.id,...(p.agent_id==='alice'?{error:{code:'UNAVAILABLE'}}:{result:{candidate_id:task.payload.candidate_id,owner_agent_id:p.agent_id,verified:true,total_cents:5000,delivery_cents:0,quoted_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}})});}
  assert.equal(c.plan.status,'quote_incomplete');assert.equal(c.plan.exact,false);assert.equal(c.plan.best,undefined);assert.throws(()=>c.checkout('x'),/全员确认/);
});
test('live quote aggregate is reconstructed and member tasks do not carry others history, rights or bills',async()=>{
  const c=await liveReady();c.optimize();for(const p of c.session.participants)for(const task of c.getTasks(p.agent_id).tasks){if(task.type!=='quote')continue;assert.ok(!JSON.stringify(task.payload).includes('history'));assert.ok(!JSON.stringify(task.payload).includes('participant_bills'));assert.ok(task.payload.session.participants.every(x=>!x.account));c.result(p.agent_id,{task_id:task.id,result:{candidate_id:task.payload.candidate_id,owner_agent_id:p.agent_id,verified:true,total_cents:5000,delivery_cents:100,quoted_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}});}
  assert.equal(c.plan.status,'verified');const b=c.plan.best;assert.equal(b.discount_cents,b.participant_bills.reduce((s,x)=>s+x.discount_cents,0));assert.equal(b.food_cents-b.discount_cents+b.delivery_cents,b.total_cents);
  for(const p of c.session.participants){const task=c.getTasks(p.agent_id).tasks.find(t=>t.type==='proposal');assert.equal(task.payload.bill.agent_id,p.agent_id);}
});
test('unknown discount amount can be quoted as one explicitly bound coupon without invented stacking',async()=>{
  const c=await liveReady();const person=structuredClone(c.session.participants[1]);const option=person.options[0];person.account.coupons=[{id:'coupon-explicit-probe',name:'单券核价测试',known:false,quote_only:true,product_skus:[option.items[0].sku],binding_summary:{agent_id:person.agent_id,option_id:option.id,item_index:0,base_sku:option.items[0].sku,product_sku:option.items[0].sku,owner_confirmed:true}}];c.snapshot(person.agent_id,person);c.optimize();
  const tasks=c.getTasks(person.agent_id).tasks.filter(t=>t.type==='quote');assert.equal(tasks.length,2);assert.equal(tasks.filter(t=>t.payload.candidate.coupon_ids.length===1).length,1);assert.ok(tasks.every(t=>t.payload.candidate.coupon_ids.length<=1));
});
test('collection response must not erase remaining member tasks',async()=>{
  const c=new Coordinator();await c.loadDemo();const inputs=structuredClone(c.demoInput.participants);c.demo=false;await c.collect();
  for(const p of inputs){const task=c.getTasks(p.agent_id).tasks[0];assert.equal(task.type,'collect');c.result(p.agent_id,{task_id:task.id,result:p});}
  assert.equal(c.session.status,'ready');
});
test('collect is idempotent, retired responses are accepted without undoing the newer quote round',async()=>{
  const c=await liveReady();for(const p of c.session.participants)p.status='invited';await c.collect();const initial=c.session.participants.map(p=>({id:p.agent_id,task:c.getTasks(p.agent_id).tasks[0],snapshot:structuredClone(p)}));await c.collect();assert.ok(initial.every(x=>c.getTasks(x.id).tasks.filter(t=>t.type==='collect').length===1));
  for(const x of initial)c.result(x.id,{task_id:x.task.id,result:x.snapshot});c.optimize();const hashOrStatus=c.plan.status;const count=c.getTasks(initial[0].id).tasks.length;c.result(initial[0].id,{task_id:initial[0].task.id,result:initial[0].snapshot});assert.equal(c.plan.status,hashOrStatus);assert.equal(c.getTasks(initial[0].id).tasks.length,count);
});
test('real coordinator cannot mark hand-entered amount as paid or approve for a participant',async()=>{
  const app=await startServer({port:0});try{
    await app.coordinator.loadDemo();app.coordinator.demo=false;
    const post=(path,body={},key=app.adminKey,origin)=>fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`,...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
    assert.equal((await post('/api/approve',{agent_id:'any',plan_hash:'any'})).status,403);
    assert.equal((await post('/api/settle',{actual_total_cents:1})).status,403);
    assert.equal((await post('/api/collect',{},app.adminKey,'https://evil.invalid')).status,403);
    const person=app.coordinator.session.participants[0];const memberKey=app.coordinator.identities.get(person.agent_id).secret;
    assert.equal((await post('/api/agent/approve',{agent_id:'different',plan_hash:'any'},memberKey)).status,401);
    assert.equal((await fetch(app.url+'/api/state')).status,401);
  }finally{await new Promise(r=>app.server.close(r));}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { MemberAgent } from '../src/member.mjs';

// Four actual MemberAgent runtimes communicate over authenticated HTTP. Their MCP
// responses are synthetic official-shape stubs, not live McDonald's responses.
test('four member runtimes relay history, own-account quotes, selected checkout and personal AA receipts over HTTP',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'together-relay-'));
  const app=await startServer({port:0});t.after(async()=>{await new Promise(r=>app.server.close(r));await rm(directory,{recursive:true,force:true});});
  const ids=['alice','bob','chen','ding'];
  const invites=app.coordinator.create({store_id:'test-store',service_mode:'pickup',fulfillment_key:'test-counter',participants:ids.map(agent_id=>({agent_id,name:agent_id})),split_policy:'proportional'});
  const calls=new Map(),members=new Map();
  const schemas=[['order-list',[]],['query-my-coupons',[]],['query-my-account',[]],['query-store-coupons',['storeCode','beCode','beType','orderType']],['query-meals',['storeCode','beCode','beType','orderType']],['calculate-price',['storeCode','beCode','beType','orderType','items','needTableware']],['create-order',['storeCode','beCode','beType','takeWayCode','items','needTableware']],['query-order',['orderId']]].map(([name,fields])=>({name,inputSchema:{type:'object',properties:Object.fromEntries(fields.map(k=>[k,{type:k==='items'?'array':k==='needTableware'?'boolean':['beType','orderType'].includes(k)?'integer':'string'}]))}}));
  const ok=data=>({structuredContent:{success:true,code:200,data}});
  for(const agent_id of ids){
    calls.set(agent_id,[]);const unit=agent_id==='bob'?1700:2300;
    const client={listTools:async()=>schemas,callTool:async(name,args)=>{
      calls.get(agent_id).push(name);
      if(name==='order-list')return ok({list:[{orderId:'private-stub-id',orderStatus:'订单已完成',address:'never-shared',orderProductList:[{productName:'虚构汉堡',productCode:'historical-never-replay',quantity:1}]}]});
      if(name==='query-my-coupons')return {content:[{type:'text',text:'仅本机私人卡券摘要'}]};
      if(name==='query-my-account')return ok({availablePoint:1234});
      if(name==='query-store-coupons')return ok([]);
      if(name==='query-meals')return ok({meals:{'test-burger':{name:'虚构汉堡',currentPrice:(unit/100).toFixed(2),originalPrice:'23.00',discountType:agent_id==='bob'?'麦金卡优惠':null}}});
      const total=args.items?.reduce((a,i)=>a+unit*i.quantity,0)??unit*4;
      if(name==='calculate-price')return ok({price:total,deliveryPrice:0,productPrice:total,productList:args.items.map(i=>({productCode:i.productCode,quantity:i.quantity,originalSubtotal:2300*i.quantity,subtotal:unit*i.quantity})),takeWayList:[{code:'counter'}]});
      if(name==='create-order')return ok({orderId:'private-created-stub',payH5Url:'https://m.mcd.cn/payment?stub=private',orderDetail:{orderStatus:'待支付'}});
      if(name==='query-order')return ok({orderId:'private-created-stub',orderStatus:'订单已完成',realTotalAmount:(unit*4/100).toFixed(2),realDeliveryPrice:'0.00'});
      throw Error('unexpected stub tool');
    }};
    members.set(agent_id,new MemberAgent({profile:{agent_id,name:agent_id,context:{storeCode:'test-store',beCode:'test-be',beType:1,orderType:1},fulfillment_key:'test-counter',takeWayCode:'counter',budget_cents:5000,history:{shared:true},options:[{id:`${agent_id}-burger`,label:'虚构汉堡',items:[{sku:'test-burger',quantity:1}]}]},client,ledgerPath:join(directory,agent_id,'ledger.private.json')}));
  }
  const wire=async(id,path,body)=>{const response=await fetch(app.url+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${invites.find(i=>i.agent_id===id).secret}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify({agent_id:id,...body})}:{})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
  await app.coordinator.collect();
  for(const id of ids){const task=(await wire(id,`/api/agent/tasks?agent_id=${id}`)).tasks.find(t=>t.type==='collect');await wire(id,'/api/agent/result',{task_id:task.id,result:await members.get(id).collect()});}
  assert.equal(app.coordinator.session.status,'ready');assert.ok(!JSON.stringify(app.coordinator.state()).includes('private-stub-id'));assert.ok(app.coordinator.session.participants.every(p=>p.history.source==='mcp'&&p.history.completed_order_count===1&&p.history.favorites[0].name==='虚构汉堡'));
  app.coordinator.optimize();
  for(const id of ids)for(const task of (await wire(id,`/api/agent/tasks?agent_id=${id}`)).tasks.filter(t=>t.type==='quote'))await wire(id,'/api/agent/result',{task_id:task.id,result:await members.get(id).quote(task.payload)});
  assert.equal(app.coordinator.plan.status,'verified');assert.equal(app.coordinator.plan.best.owner_agent_id,'bob');assert.equal(app.coordinator.plan.best.total_cents,6800);
  const hash=app.coordinator.plan.plan_hash;
  for(const id of ids){await members.get(id).approveLocal(hash,{explicitOwnerApproval:true});await wire(id,'/api/agent/approve',{plan_hash:hash});}
  app.coordinator.checkout(hash);
  for(const id of ids){const tasks=(await wire(id,`/api/agent/tasks?agent_id=${id}`)).tasks;const checkout=tasks.filter(t=>t.type==='checkout');assert.equal(checkout.length,id==='bob'?1:0);if(checkout.length)await wire(id,'/api/agent/result',{task_id:checkout[0].id,result:await members.get(id).checkout(checkout[0].payload)});}
  assert.equal(app.coordinator.session.status,'awaiting_payment');assert.ok(!JSON.stringify(app.coordinator.state()).includes('https://m.mcd.cn/payment'));assert.equal(calls.get('bob').filter(n=>n==='create-order').length,1);
  app.coordinator.requestPayment();const task=(await wire('bob','/api/agent/tasks?agent_id=bob')).tasks.find(t=>t.type==='payment');await wire('bob','/api/agent/result',{task_id:task.id,result:await members.get('bob').syncPayment(task.payload)});
  assert.equal(app.coordinator.session.status,'settled');assert.equal(app.coordinator.exportBills().bills.reduce((s,b)=>s+b.payable_cents,0),6800);
  for(const id of ids){const task=(await wire(id,`/api/agent/tasks?agent_id=${id}`)).tasks.find(t=>t.type==='bill');assert.equal(task.payload.bill.agent_id,id);assert.ok(!JSON.stringify(task.payload).includes('participant_bills'));await wire(id,'/api/agent/result',{task_id:task.id,result:{status:'bill_received'}});}
  assert.ok(app.coordinator.outbox.every(b=>b.status==='delivered'));
});

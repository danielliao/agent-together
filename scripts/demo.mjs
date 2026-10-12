import { Coordinator } from '../src/coordinator.mjs';
const host=new Coordinator();await host.loadDemo();await host.collect();host.optimize();
for(const p of host.session.participants)host.approve(p.agent_id,host.plan.plan_hash,{demo:true});
host.checkout(host.plan.plan_hash);host.settle();
console.log(JSON.stringify({label:'虚构演示：没有创建订单或支付',plan:host.plan,bill:host.exportBills(),agent_receipts:host.outbox},null,2));

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Coordinator } from './coordinator.mjs';
import { assert, sameSecret, secret, TogetherError } from './protocol.mjs';

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
export async function startServer({port=4380,coordinator=new Coordinator(),adminKey=secret()}={}){
  const server=http.createServer(async(req,res)=>{
    const send=(status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(typeof value==='string'?value:JSON.stringify(value));};
    try{
      const bound=server.address().port;const origins=[`http://127.0.0.1:${bound}`,`http://localhost:${bound}`];
      assert(origins.includes(`http://${req.headers.host}`),'INVALID_HOST','访问地址不正确。',403);
      const url=new URL(req.url,origins[0]);
      const cookies=Object.fromEntries((req.headers.cookie??'').split(';').map(v=>v.trim().split('=')));
      const bearer=/^Bearer ([^\s]+)$/.exec(req.headers.authorization??'')?.[1];
      const admin=sameSecret(cookies.together_admin,adminKey)||sameSecret(bearer,adminKey);
      if(req.method==='GET'&&!url.pathname.startsWith('/api/')){
        const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=files[url.pathname];assert(file,'NOT_FOUND','页面不存在。',404);
        const ext=file.slice(file.lastIndexOf('.'));send(200,await readFile(new URL(`../web/${file}`,import.meta.url),'utf8'),{'Content-Type':mime[ext],'Set-Cookie':`together_admin=${adminKey}; HttpOnly; SameSite=Strict; Path=/`,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});return;
      }
      assert(!req.headers.origin||origins.includes(req.headers.origin),'INVALID_ORIGIN','仅允许同源页面操作。',403);
      let body={};if(req.method==='POST'){
        assert((req.headers['content-type']??'').includes('application/json'),'INVALID_CONTENT_TYPE','请发送 JSON。',415);
        let bytes=0,parts=[];for await(const part of req){bytes+=part.length;assert(bytes<=512*1024,'BODY_TOO_LARGE','请求过大。',413);parts.push(part);}
        try{body=JSON.parse(Buffer.concat(parts).toString()||'{}');}catch{throw new TogetherError('INVALID_JSON','JSON 无法解析。');}
      }
      if(url.pathname.startsWith('/api/agent/')){
        const id=body.agent_id??url.searchParams.get('agent_id');const identity=coordinator.identities.get(id);assert(identity&&sameSecret(bearer,identity.secret),'UNAUTHORIZED_AGENT','成员身份验证失败。',401);
        if(req.method==='GET'&&url.pathname==='/api/agent/tasks'){send(200,coordinator.getTasks(id));return;}
        if(req.method==='POST'&&url.pathname==='/api/agent/snapshot'){send(200,{ok:true,status:coordinator.snapshot(id,body.snapshot??body).session.status});return;}
        if(req.method==='POST'&&url.pathname==='/api/agent/approve'){coordinator.approve(id,body.plan_hash);send(200,{ok:true});return;}
        if(req.method==='POST'&&url.pathname==='/api/agent/result'){coordinator.result(id,body);send(200,{ok:true});return;}
        if(req.method==='POST'&&url.pathname==='/api/agent/ack'){coordinator.acknowledge(id,body.task_id);send(200,{ok:true});return;}
        throw new TogetherError('NOT_FOUND','成员接口不存在。',404);
      }
      assert(admin,'UNAUTHORIZED','请从本机页面访问。',401);
      if(req.method==='GET'&&url.pathname==='/api/state'){send(200,coordinator.state());return;}
      if(req.method==='GET'&&url.pathname==='/api/exports/bills'){send(200,coordinator.exportBills(),{'Content-Disposition':'attachment; filename="agent-together-bills.json"'});return;}
      assert(req.method==='POST','NOT_FOUND','接口不存在。',404);
      switch(url.pathname){
        case '/api/session':send(200,{invites:coordinator.create(body),state:coordinator.state()});return;
        case '/api/demo':await coordinator.loadDemo(body.scenario??'office');break;
        case '/api/collect':await coordinator.collect();break;
        case '/api/optimize':coordinator.optimize();break;
        case '/api/approve':assert(coordinator.demo,'MEMBER_APPROVAL_ONLY','真实成员只能用自己的邀请凭证确认。',403);coordinator.approve(body.agent_id,body.plan_hash,{demo:true});break;
        case '/api/checkout':coordinator.checkout(body.plan_hash);break;
        case '/api/settle':coordinator.settle(body.actual_total_cents);break;
        case '/api/reconcile':coordinator.proposeReconciliation();break;
        case '/api/payment-status':coordinator.requestPayment();break;
        case '/api/reset':assert(!coordinator.checkoutStarted||coordinator.session?.status==='settled','ORDER_IN_PROGRESS','未确认订单不能重置。',409);await coordinator.loadDemo();break;
        default:throw new TogetherError('NOT_FOUND','接口不存在。',404);
      }
      send(200,coordinator.state());
    }catch(e){send(e.status??400,{error:{code:e.code??'REQUEST_FAILED',message:e.code?e.message:'操作未完成，请检查已收集的配置。'}});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return {server,coordinator,adminKey,url:`http://127.0.0.1:${server.address().port}`};
}

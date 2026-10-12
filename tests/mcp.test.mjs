import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient } from '../src/mcp.mjs';
function stub({sse=false,expiredCreate=false}={}){
  const calls=[];const fetchImpl=async(url,req)=>{
    const rpc=JSON.parse(req.body);calls.push(rpc);
    const response=result=>new Response(sse?`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})}\n\n`:JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}),{headers:{'content-type':sse?'text/event-stream':'application/json','mcp-session-id':'session1'}});
    if(rpc.method==='initialize')return response({protocolVersion:'2025-06-18',capabilities:{tools:{}}});
    if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
    if(rpc.method==='tools/list')return response({tools:['order-list','calculate-price','create-order'].map(name=>({name,inputSchema:{type:'object',properties:{},additionalProperties:true}}))});
    if(rpc.params.name==='create-order'&&expiredCreate)return new Response('DO_NOT_EXPOSE_TOKEN',{status:404});
    return response({content:[{type:'text',text:'{"success":true,"code":200,"data":{"list":[]}}'}]});
  };return {calls,fetchImpl};
}
for(const sse of [false,true])test(`read tools negotiate initialize/session and ${sse?'SSE':'JSON'}`,async()=>{const s=stub({sse});const client=new McpClient({token:'synthetic-fixture',fetchImpl:s.fetchImpl});await client.callTool('order-list',{});assert.deepEqual(s.calls.map(c=>c.method),['initialize','notifications/initialized','tools/list','tools/call']);});
test('mutation is gated and no coupon claiming or money spending tools exist in allowlist',async()=>{const s=stub();const c=new McpClient({token:'synthetic-fixture',fetchImpl:s.fetchImpl});await assert.rejects(()=>c.callTool('create-order',{}),{code:'tool_not_allowed'});await assert.rejects(()=>c.callTool('auto-bind-coupons',{}),{code:'tool_not_allowed'});assert.equal(s.calls.length,0);});
test('ambiguous create-order session error is never replayed',async()=>{const s=stub({expiredCreate:true});const c=new McpClient({token:'synthetic-fixture',fetchImpl:s.fetchImpl});await assert.rejects(()=>c.callTool('create-order',{}, {mutationAuthorized:true}),{code:'session_expired'});assert.equal(s.calls.filter(x=>x.params?.name==='create-order').length,1);});
test('credentials may only go to official MCP or loopback test endpoints',()=>{assert.throws(()=>new McpClient({token:'synthetic-fixture',endpoint:'https://evil.invalid'}),{code:'invalid_endpoint'});});

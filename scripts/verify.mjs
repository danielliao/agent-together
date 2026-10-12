#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, McpError } from '../src/mcp.mjs';
import { officialPayload, historyRecords, summarizeHistory } from '../src/history.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '单账号只读 MCP 连接、近期历史摘要处理、卡券与积分查询；未验证多账号核价、下单或支付';
const READ_TOOLS = ['order-list', 'query-my-coupons', 'query-my-account'];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function checkedCouponSummary(raw) {
  if (raw?.isError) throw new McpError('tool_error', '只读券查询未成功。');
  try { officialPayload(raw); return 'business_confirmed'; }
  catch (error) { if (error.code !== 'unsupported_response_schema') throw error; }
  const texts = (raw?.content ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text.trim());
  // The official public guide documents this Markdown success form, not numeric coupon rules.
  if (texts.some(text => /^#\s*您的优惠券列表(?:\s|$)/.test(text) && /共\s*\d+\s*张可用优惠券/.test(text))) return 'business_confirmed';
  if (texts.some(text => text.length > 0)) return 'protocol_nonerror';
  throw new McpError('unsupported_response_schema', '只读券查询没有已确认的工具响应。');
}

async function saveMetadata(path, metadata) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temp, path); await chmod(path, 0o600); }
  finally { await unlink(temp).catch(() => {}); }
}

/** Dedicated local verifier. Tokens never enter the coordinator or result metadata. */
export async function startVerifier({ port = 4381, clientFactory = token => new McpClient({ token }), recordPath = resolve(root, 'work/verification.json'), now = () => Date.now() } = {}) {
  const session = randomBytes(24).toString('base64url');
  let status = { status: 'pending', verified_at: null, checks: [], scope: SCOPE };
  let busy = false;
  const server = createServer(async (req, res) => {
    const send = (code, value, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    const currentPort = server.address()?.port;
    const origin = `http://127.0.0.1:${currentPort}`;
    if (req.headers.host !== `127.0.0.1:${currentPort}`) { send(421, { error: '本机访问地址不正确。' }); return; }
    let path;
    try { path = new URL(req.url, origin).pathname; } catch { send(400, { error: '请求地址无效。' }); return; }
    if (req.method === 'GET' && path === '/status') { send(200, status); return; }
    if (req.method === 'GET' && ['/', '/verify.html', '/verify.js'].includes(path)) {
      try {
        const file = path === '/verify.js' ? 'verify.js' : 'verify.html';
        const contents = await readFile(resolve(root, 'web', file), 'utf8');
        send(200, contents, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
          'Set-Cookie': `together_verify=${session}; HttpOnly; SameSite=Strict; Path=/`,
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
      } catch { send(500, { error: '本机验证页未能打开。' }); }
      return;
    }
    if (req.method !== 'POST' || path !== '/verify') { send(404, { error: '路径不存在。' }); return; }
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(part => part.trim().split('=')));
    if (req.headers.origin !== origin || !same(cookies.together_verify, session) || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { send(403, { error: '请从本机验证页发起请求。' }); return; }
    if (busy) { send(409, { error: '这次验证尚未结束，请等待。' }); return; }
    busy = true;
    status = { status: 'pending', verified_at: null, checks: [], scope: SCOPE };
    let body = '', token = '';
    let checks = [];
    let currentCheck = 'input';
    try {
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 8192) throw new McpError('invalid_token_input', '输入超过本机上限。');
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw new McpError('invalid_token_input', '输入格式无效。'); }
      if (typeof parsed.token !== 'string' || !parsed.token.trim() || parsed.token.length > 4096 || Object.keys(parsed).some(key => key !== 'token')) throw new McpError('invalid_token_input', '请只提交本机 Token。');
      token = parsed.token.trim(); parsed.token = ''; parsed = null; body = '';
      const client = clientFactory(token);
      currentCheck = 'initialize'; await client.initialize(); checks.push({ tool: currentCheck, success: true, level: 'protocol_confirmed' });
      currentCheck = 'tools/list';
      const tools = await client.listTools();
      if (!Array.isArray(tools) || READ_TOOLS.some(name => !tools.some(tool => tool.name === name))) throw new McpError('tool_unavailable', '所需只读工具未被发现。');
      checks.push({ tool: currentCheck, success: true, level: 'protocol_confirmed' });
      currentCheck = 'order-list';
      const history = historyRecords(await client.callTool('order-list', {}));
      // Computed solely in this request's memory; no real names or counts leave it.
      const summary = summarizeHistory(history, { shared: true });
      if (summary.shared !== true || !Array.isArray(summary.foods)) throw new McpError('summary_failed', '近期摘要未正确处理。');
      checks.push({ tool: currentCheck, success: true, level: 'business_confirmed' });
      currentCheck = 'query-my-coupons'; const couponLevel = checkedCouponSummary(await client.callTool(currentCheck, {})); checks.push({ tool: currentCheck, success: true, level: couponLevel });
      currentCheck = 'query-my-account';
      const account = officialPayload(await client.callTool(currentCheck, {})).data;
      if (!account || typeof account !== 'object' || Array.isArray(account) || !['string', 'number'].includes(typeof account.availablePoint) || !/^\d+(?:\.\d+)?$/.test(String(account.availablePoint))) throw new McpError('unsupported_response_schema', '积分只读查询未提供已确认的成功结构。');
      checks.push({ tool: currentCheck, success: true, level: 'business_confirmed' });
      const verifiedAt = new Date(now()).toISOString();
      const metadata = { status: 'passed', verified_at: verifiedAt, checks, scope: SCOPE, protocol: 'MCP Streamable HTTP', summary_processed: true };
      await saveMetadata(resolve(recordPath), metadata);
      status = { status: 'passed', verified_at: verifiedAt, checks, scope: SCOPE };
      send(200, status);
    } catch {
      if (!checks.some(check => check.tool === currentCheck)) checks.push({ tool: currentCheck, success: false });
      status = { status: 'failed', verified_at: new Date(now()).toISOString(), checks, scope: SCOPE };
      send(422, status);
    } finally { token = ''; body = ''; busy = false; }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, getStatus: () => structuredClone(status) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startVerifier().then(app => {
  process.stdout.write(`一起来麦本机只读验证：http://127.0.0.1:${app.server.address().port}\n由主人自行在密码框填写；不下单或支付。\n`);
}).catch(() => { process.stderr.write('本机验证服务无法启动，请检查 4381 端口。\n'); process.exitCode = 1; });

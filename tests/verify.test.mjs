import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startVerifier } from '../scripts/verify.mjs';

// Entirely synthetic clients and data; never the live verifier on port 4381.
const TOKEN = 'synthetic-private-token-not-real';
const ok = data => ({ structuredContent: { success: true, code: 200, data } });
async function fixture(t, { handle, markdown = '# 您的优惠券列表\n\n共 0 张可用优惠券' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'together-verifier-test-'));
  const recordPath = join(directory, 'private', 'verification.json');
  const calls = [], tokens = [];
  const app = await startVerifier({ port: 0, recordPath, clientFactory(token) {
    tokens.push(token);
    return { async initialize() { calls.push('initialize'); }, async listTools() { calls.push('tools/list'); return ['order-list', 'query-my-coupons', 'query-my-account'].map(name => ({ name })); }, async callTool(name) {
      calls.push(name);
      if (handle) { const result = await handle(name); if (result !== undefined) return result; }
      if (name === 'order-list') return ok({ list: [{ orderId: 'private-order-reference', orderStatus: '订单已完成', address: 'private-home', phone: '13812345678', orderProductList: [{ productName: 'private-real-food-name', quantity: 1 }] }] });
      if (name === 'query-my-coupons') return { content: [{ type: 'text', text: markdown }] };
      if (name === 'query-my-account') return ok({ availablePoint: '1234', accountId: 'private-account', phone: '13812345678' });
      throw new Error('unexpected synthetic tool');
    } };
  } });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); await rm(directory, { recursive: true, force: true }); });
  const page = await fetch(app.url);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const post = (body = { token: TOKEN }, extra = {}) => fetch(`${app.url}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url, Cookie: cookie, ...extra }, body: JSON.stringify(body) });
  return { ...app, cookie, calls, tokens, recordPath, post };
}

test('successful real-code read sequence records only allowed metadata, never credentials or actual content', async t => {
  const f = await fixture(t);
  assert.equal((await (await fetch(`${f.url}/status`)).json()).status, 'pending');
  const response = await f.post(); assert.equal(response.status, 200);
  const status = await response.json(); assert.equal(status.status, 'passed');
  assert.deepEqual(f.calls, ['initialize', 'tools/list', 'order-list', 'query-my-coupons', 'query-my-account']);
  assert.deepEqual(f.tokens, [TOKEN]);
  const record = await readFile(f.recordPath, 'utf8');
  for (const privateValue of [TOKEN, 'private-order-reference', 'private-home', '13812345678', 'private-real-food-name', 'private-account', '1234']) assert.ok(!record.includes(privateValue));
  assert.doesNotMatch(JSON.stringify(status), /order_count|sample_size|foods|availablePoint|token/);
  const metadata = JSON.parse(record); assert.equal(metadata.summary_processed, true); assert.equal(metadata.protocol, 'MCP Streamable HTTP');
  assert.equal(metadata.checks.find(check => check.tool === 'order-list').level, 'business_confirmed');
  assert.equal((await stat(f.recordPath)).mode & 0o777, 0o600);
});

test('same-origin session cookie and Host checks reject cross-origin or unauthenticated submissions before reading MCP', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ token: TOKEN }, { Origin: 'https://outsider.example' })).status, 403);
  assert.equal((await f.post({ token: TOKEN }, { Cookie: '' })).status, 403);
  const hostileHost = await new Promise((done, reject) => {
    const url = new URL(f.url);
    const req = request({ hostname: '127.0.0.1', port: url.port, path: '/verify', method: 'POST', headers: { Host: 'outsider.example', Origin: f.url, Cookie: f.cookie, 'Content-Type': 'application/json' } }, response => { response.resume(); response.on('end', () => done(response.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify({ token: TOKEN }));
  });
  assert.equal(hostileHost, 421);
  assert.equal(f.calls.length, 0); assert.equal(f.tokens.length, 0);
  await assert.rejects(readFile(f.recordPath), { code: 'ENOENT' });
});

test('empty and oversized inputs cannot run tools or produce a passed verification', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ token: '' })).status, 422);
  const tooLong = await f.post({ token: 'x'.repeat(4097) }); assert.equal(tooLong.status, 422);
  try { const oversized = await f.post({ token: 'x'.repeat(10_000) }); assert.notEqual(oversized.status, 200); } catch { /* Closing an oversized request is also a rejection. */ }
  assert.equal(f.calls.length, 0); assert.equal(f.getStatus().status, 'failed');
  await assert.rejects(readFile(f.recordPath), { code: 'ENOENT' });
});

test('business failures never fall back to a successful protocol claim or save a passed record', async t => {
  const f = await fixture(t, { handle(name) { if (name === 'query-my-coupons') return { structuredContent: { success: false, code: 401, message: TOKEN, data: { account: 'private-account' } }, content: [{ type: 'text', text: '# 您的优惠券列表\n共 1 张可用优惠券' }] }; } });
  const response = await f.post(); assert.equal(response.status, 422);
  const status = await response.json(); assert.equal(status.status, 'failed');
  assert.equal(status.checks.at(-1).tool, 'query-my-coupons'); assert.equal(status.checks.at(-1).success, false);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private|private-account/);
  assert.equal(f.calls.includes('query-my-account'), false);
  await assert.rejects(readFile(f.recordPath), { code: 'ENOENT' });
});

test('unrecognized Markdown is labeled protocol-only while confirmed history and account remain distinct', async t => {
  const f = await fixture(t, { markdown: '这是未校准的合成券摘要格式。' });
  const status = await (await f.post()).json();
  assert.equal(status.status, 'passed');
  assert.equal(status.checks.find(check => check.tool === 'query-my-coupons').level, 'protocol_nonerror');
  assert.equal(status.checks.find(check => check.tool === 'query-my-account').level, 'business_confirmed');
  assert.match(status.scope, /未验证多账号核价、下单或支付/);
});

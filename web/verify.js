const form = document.getElementById('verify-form');
const input = document.getElementById('token-input');
const button = document.getElementById('verify-button');
const status = document.getElementById('status');
const checks = document.getElementById('checks');
const labels = { initialize: '官方 MCP 连接', 'tools/list': '发现当前只读工具', 'order-list': '近期历史读取及内存摘要', 'query-my-coupons': '本人优惠券查询', 'query-my-account': '本人积分查询', input: '本机输入格式' };
function show(result) {
  checks.replaceChildren();
  for (const check of result.checks ?? []) {
    const item = document.createElement('li');
    item.textContent = `${check.success ? '✓' : '未通过'} ${labels[check.tool] ?? '只读步骤'}${check.level === 'protocol_nonerror' ? '（工具未报协议错误；业务格式待校准）' : ''}`;
    checks.append(item);
  }
  status.textContent = result.status === 'passed' ? '只读验证通过。记录已保存；多人下单和支付没有被验证。' : result.status === 'failed' ? '验证未通过，请检查 Token 有效期和网络后重试。未保存凭据或真实内容。' : '尚未验证。';
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  let token = input.value.trim();
  input.value = '';
  if (!token) { status.textContent = '请由你自己粘贴 Token。'; return; }
  button.disabled = true; input.disabled = true;
  status.textContent = '正在连接官方 MCP 并执行只读查询，请稍候…'; checks.replaceChildren();
  try {
    const response = await fetch('/verify', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    token = '';
    const result = await response.json();
    if (!['passed', 'failed'].includes(result.status)) throw new Error('未完成');
    show(result);
  } catch { status.textContent = '本机验证未完成，请检查本机服务后重试。'; }
  finally { token = ''; input.value = ''; input.disabled = false; button.disabled = false; }
});
fetch('/status', { cache: 'no-store' }).then(response => response.json()).then(show).catch(() => { status.textContent = '本机服务尚未连接。'; });

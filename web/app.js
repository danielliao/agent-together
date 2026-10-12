(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const scenarioLabels = { office: '办公室拼单', expired: '券过期了', budget: '有人超预算' };
  const memberStatuses = { invited: '等待 Agent 入桌', collecting: '收集偏好与需求', joined: 'Agent 已入桌', ready: '需求与权益已就绪', collected: '需求与权益已就绪', approved: '主人已模拟确认', connected: 'Agent 已连接' };
  let state = { session: { status: 'collecting', participants: [] }, plan: null, events: [], outbox: [], demo: true, capabilities: { live_checkout: false } };
  let busy = false;
  let scenario = 'office';
  let loaded = false;
  let invites = [];

  function text(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, '[已隐藏]').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[已隐藏]').slice(0, 500);
  }
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = text(content);
    return node;
  }
  function array(value) { return Array.isArray(value) ? value : []; }
  function participants() { return array(state.session?.participants).slice(0, 20); }
  function nameFor(id) { return participants().find(person => person.agent_id === id)?.name || '该成员'; }
  function cents(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function money(value) { return cents(value) === null ? '待核价' : `¥${(value / 100).toFixed(2)}`; }
  function sum(rows, key) { return rows.every(row => cents(row[key]) !== null) ? rows.reduce((total, row) => total + row[key], 0) : null; }
  function isDemo() { return state.demo !== false; }
  function bestPlan() { return state.plan?.best || null; }
  function planHash() { return state.plan?.plan_hash || state.plan?.hash || bestPlan()?.plan_hash || ''; }
  function paid() { return state.session?.status === 'settled'; }
  function reconciliationRequired() { return state.session?.status === 'reconciliation_required'; }
  function reconciliationProposed() { return state.session?.status === 'reconciliation_proposed'; }
  function reconciliationStage() { return reconciliationRequired() || reconciliationProposed(); }
  function receiptPlan() { return state.plan?.reconciliation === true; }
  function ordered() { return ['submitting', 'order_uncertain', 'awaiting_payment', 'reconciliation_required', 'reconciliation_proposed', 'settled'].includes(state.session?.status); }
  function approvedIds() {
    const hashes = array(state.plan?.approved_agent_ids);
    const others = participants().filter(person => person.approval?.approved && person.approval.plan_hash === planHash()).map(person => person.agent_id);
    return new Set([...hashes, ...others]);
  }
  function announce(message, error = false) { $('status-message').textContent = text(message); $('status-message').classList.toggle('error', error); }
  function setBusy(value, label) {
    busy = value;
    $('relay-button').textContent = value ? label || 'Agent 正在协作…' : '让 Agent 接力 →';
    render();
  }
  async function request(path, data) {
    if (!/^https?:$/.test(location.protocol)) throw new Error('请通过作品的本机服务打开页面，再开始 Agent 接力。');
    const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: data === undefined ? undefined : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('本机服务没有返回可读的结果，请确认服务正在运行。'); }
    if (!response.ok || payload.error) {
      const message = text(payload.error?.message);
      throw new Error(message && /[\u4e00-\u9fff]/.test(message) ? message : '这一步还没有完成，请检查前面的确认与连接状态后重试。');
    }
    return payload;
  }
  async function refresh() {
    const next = await request('/api/state');
    if (!next || !next.session || !Array.isArray(next.session.participants)) throw new Error('会话数据格式不正确，请重启本机服务。');
    state = next;
    loaded = true;
    if (Object.hasOwn(scenarioLabels, state.session.scenario)) scenario = state.session.scenario;
    render();
  }
  async function mutate(path, data, message) {
    if (busy) return;
    setBusy(true, '正在更新这一桌…'); announce('');
    try { await request(path, data); if (['/api/demo', '/api/reset'].includes(path)) clearInvites(); await refresh(); if (message) announce(message); }
    catch (error) { announce(error.message, true); }
    finally { setBusy(false); }
  }
  function avatar(person, index) {
    const initials = Array.from(text(person.name || 'Agent')).slice(0, 1).join('');
    return el('span', `avatar color-${index % 4}`, initials);
  }
  function demandSummary(person) {
    const need = person.request;
    if (typeof need === 'string') return need;
    if (typeof need?.summary === 'string') return need.summary;
    const items = array(need?.items).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean);
    if (items.length) return items.join(' · ');
    if (typeof person.preferences?.summary === 'string') return person.preferences.summary;
    return '等待主人分享本次想吃的餐品。';
  }
  function rightSummary(right) {
    const actualName = typeof right?.name === 'string' && right.name !== right.id ? right.name : typeof right?.label === 'string' ? right.label : '';
    const summary = typeof right?.summary === 'string' && right.summary !== '以本人账号核价为准' ? right.summary : typeof right?.description === 'string' ? right.description : '';
    if (actualName && summary) return actualName === summary ? actualName : `${actualName} · ${summary}`;
    let declared = '';
    if (right?.known === false) declared = right.quote_only === true ? '限定餐品券 · 以本人账号核价为准' : '权益规则待核验';
    else if (right?.type === 'fixed' && cents(right.amount_cents) !== null) declared = `${right.min_food_cents > 0 ? `满 ${money(right.min_food_cents)} ` : ''}减 ${money(right.amount_cents)}`;
    else if (right?.type === 'percent' && Number.isSafeInteger(right.discount_bps)) declared = `会员优惠 ${right.discount_bps / 100}%${cents(right.max_discount_cents) !== null ? ` · 最多减 ${money(right.max_discount_cents)}` : ''}`;
    else if (right?.type === 'delivery_waived') declared = '配送费减免权益';
    return [actualName, summary || declared].filter(Boolean).join(' · ') || '以本人账号核价为准';
  }
  function participantCard(person, index) {
    const card = el('article', 'participant-card');
    const top = el('div', 'participant-top');
    const identity = el('div', 'participant-identity');
    identity.append(el('h3', '', person.name || `成员 ${index + 1}`), el('small', '', `AGENT ${String(index + 1).padStart(2, '0')}`));
    const ready = person.status !== 'invited' && (person.history?.shared || ['ready', 'collected', 'approved', 'connected'].includes(person.status));
    top.append(avatar(person, index), identity, el('span', `connection-dot${ready ? ' ready' : ''}`));
    const status = el('p', 'member-state', memberStatuses[person.status] || (ready ? '共享数据已就绪' : '等待 Agent 入桌'));
    const demand = el('p', 'member-request', demandSummary(person));
    const budget = el('div', 'member-budget');
    budget.append(el('span', '', '本次预算'), el('strong', '', money(person.request?.budget_cents ?? person.budget_cents)));
    const history = el('div', 'history-card');
    const title = el('div');
    const historyData = person.history;
    title.append(el('strong', '', '近期偏好'), el('span', '', isDemo() ? '虚构演示' : historyData?.shared ? historyData.source === 'mcp' ? '订单依据' : '提供者摘要' : '待共享'));
    history.append(title);
    if (historyData?.shared) {
      const favorites = array(historyData.favorites).slice(0, 2).map(food => `${text(food?.name)}${Number.isSafeInteger(food?.count) ? ` · ${food.count} 次` : ''}`).filter(Boolean);
      history.append(el('p', '', favorites.length ? favorites.join(' / ') : '已共享摘要，未提供常点餐品。'));
      const scope = [historyData.period_label, Number.isSafeInteger(historyData.completed_order_count) ? `${historyData.completed_order_count} 笔已完成订单` : null].filter(Boolean).join(' · ');
      history.append(el('small', '', scope || '只用于推荐，仍由主人选择。'));
    } else history.append(el('p', '', '等 Agent 先共享历史摘要，再收集本次需求。'));
    const rights = el('div', 'rights-list');
    const coupons = array(person.account?.coupons);
    const benefits = array(person.account?.benefits);
    const entries = [...coupons.map(right => ({ right, mark: '券' })), ...benefits.map(right => ({ right, mark: '享' }))].slice(0, 4);
    if (entries.length) for (const { right, mark } of entries) {
      const expiredAt = Date.parse(right.expires_at);
      const expired = right.valid === false || ['expired', 'invalid'].includes(right.status) || (Number.isFinite(expiredAt) && expiredAt <= Date.now());
      const row = el('div', `right-item${expired ? ' expired' : ''}`);
      row.append(el('span', 'right-mark', mark), el('span', '', `${rightSummary(right)}${expired ? '（不可用）' : ''}`)); rights.append(row);
    } else rights.append(el('p', 'rights-empty', ready ? '本次未共享可用券或会员权益。' : '权益待收集 · 凭证留在各自本机'));
    card.append(top, status, demand, budget, history, rights);
    return card;
  }
  function exactQuote() { return bestPlan()?.exact === true || state.plan?.exact === true; }
  function verifiedQuote() { return exactQuote() && state.plan?.status === 'verified'; }
  function quoteLabel() {
    const best = bestPlan();
    if (state.plan?.status === 'receipt_verified') return `${isDemo() ? '演示' : ''}${paid() ? '实付分账已确认' : '实付分账待确认'}`;
    if (reconciliationRequired()) return '原报价 · 实付已变';
    if (!best) return state.plan?.status === 'quoting' ? '各账号核价中' : state.plan?.status === 'quote_incomplete' ? '核价未完成' : '等待比价';
    if (isDemo()) return exactQuote() ? '虚构演示报价' : '演示估算 · 待核价';
    return verifiedQuote() ? '真实报价' : '估算方案 · 待核价';
  }
  function renderPlan() {
    const best = bestPlan();
    $('quote-badge').textContent = quoteLabel();
    $('plan-title').textContent = receiptPlan() ? '按已核验实付分账' : reconciliationRequired() ? '原报价与实付对账' : '一桌的最优方案';
    const content = $('plan-content'); content.replaceChildren();
    if (!best) {
      const empty = el('div', 'plan-empty');
      const quoting = state.plan?.status === 'quoting';
      empty.append(el('span', 'plan-empty-icon', '⇄'), el('h3', '', quoting ? '各位 Agent 正在自己的账号核价。' : state.plan?.status === 'quote_incomplete' ? '核价尚未完整，请重新收集后再比价。' : '先让四个 Agent 把信息带来。'), el('p', '', quoting ? `仍有 ${Number.isSafeInteger(state.plan.pending_quotes) ? state.plan.pending_quotes : '若干'} 个候选等待核价，全部回复后才确认方案。` : '收齐本次需求后，逐个账号核对可用权益，再比较同一桌餐品的总价。'));
      for (const warning of array(state.plan?.warnings).slice(0, 2)) empty.append(el('p', '', warning));
      content.append(empty); return;
    }
    const total = el('div', 'plan-total');
    const price = el('div');
    price.append(el('span', 'total-label', receiptPlan() ? '已核验实付金额' : reconciliationRequired() ? '原来已确认的报价' : ordered() ? '已锁定方案金额' : '这一桌预计应付'), el('strong', 'total-number', money(best.total_cents)), el('p', 'total-subtitle', receiptPlan() ? '仅确认实付分账 · 不创建新的订单' : reconciliationRequired() ? '实付与原报价不同 · 需重新同意分账' : isDemo() ? '虚构演示数据 · 未下真实订单' : verifiedQuote() ? '本次核价结果 · 下单前须重新确认' : '待官方核价 · 不能用于真实下单'));
    const owner = el('div', 'plan-owner');
    owner.append(el('span', '', receiptPlan() || reconciliationStage() ? '已经出单的账号' : '由这位 Agent 的账号出单'), el('strong', '', nameFor(best.owner_agent_id)));
    const tags = el('div', 'plan-tags');
    const account = participants().find(person => person.agent_id === best.owner_agent_id)?.account;
    const couponIds = array(best.coupon_ids), benefitIds = array(best.benefit_ids);
    const applied = [...array(account?.coupons).filter(right => couponIds.includes(right.id)), ...array(account?.benefits).filter(right => benefitIds.includes(right.id))];
    if (applied.length) for (const right of applied.slice(0, 3)) tags.append(el('span', 'plan-tag', rightSummary(right)));
    else tags.append(el('span', 'plan-tag', `${couponIds.length} 张券 · ${benefitIds.length} 项会员权益`));
    if (!receiptPlan() && !reconciliationStage()) owner.append(tags); total.append(price, owner); content.append(total);
    if (!receiptPlan() && !reconciliationStage() && isDemo() && state.plan.solo_baseline?.available && cents(state.plan.solo_baseline.total_cents) !== null && cents(state.plan.savings_cents) !== null) {
      content.append(el('div', 'saving-line', `虚构场景：分开点 ${money(state.plan.solo_baseline.total_cents)}，一起点少 ${money(state.plan.savings_cents)}。`));
    }
    const candidates = array(state.plan.candidates).filter(candidate => cents(candidate.total_cents) !== null).slice(0, 6);
    if (candidates.length && !receiptPlan() && !reconciliationStage()) {
      content.append(el('p', 'comparison-title', isDemo() ? '在主人允许的餐品选项中 · 比较各虚构账号' : '在主人允许的餐品选项中 · 比较各账号核价'));
      const max = Math.max(1, ...candidates.map(candidate => candidate.total_cents));
      for (const candidate of candidates) {
        const row = el('div', `comparison-row${candidate.owner_agent_id === best.owner_agent_id ? ' best' : ''}`);
        const track = el('div', 'comparison-track'), bar = el('div', 'comparison-bar');
        bar.style.width = `${Math.max(4, Math.round(candidate.total_cents / max * 100))}%`; track.append(bar);
        row.append(el('span', 'comparison-name', candidate.label || nameFor(candidate.owner_agent_id)), track, el('strong', '', money(candidate.total_cents))); content.append(row);
      }
    }
    const warnings = array(state.plan.warnings).filter(warning => typeof warning === 'string');
    if (warnings.length) content.append(el('div', 'plan-warnings', warnings.slice(0, 4).join(' ')));
  }
  function eventTime(value) {
    const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    return parsed && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Shanghai' }).format(parsed) : '协作记录';
  }
  function renderEvents() {
    const events = array(state.events);
    $('event-count').textContent = events.length;
    const rows = events.slice(-12).reverse().map(event => {
      const row = el('li', 'event-item');
      const message = event.message || event.summary || ({ collected: '需求与权益已收集', optimized: '比价方案已生成', approved: '一位主人已确认方案', settled: 'AA 账单已对账完成' }[event.type]) || '一项协作状态已更新';
      row.append(el('span', '', message), el('small', '', `${event.agent_id ? `${nameFor(event.agent_id)} · ` : ''}${eventTime(event.time || event.timestamp)}`)); return row;
    });
    if (!rows.length) rows.push(el('li', 'event-placeholder', loaded ? '还没有协作记录。点“让 Agent 接力”，先收集每个人的近期偏好与需求。' : '正在连接本机协作服务…'));
    $('event-list').replaceChildren(...rows);
  }
  function renderApprovals() {
    const best = bestPlan(); const members = participants();
    $('approval-section').hidden = !best;
    if (!best) return;
    const approved = approvedIds();
    $('approval-count').textContent = reconciliationRequired() ? '原确认需重新核对' : `${members.filter(person => approved.has(person.agent_id)).length} / ${members.length} ${receiptPlan() ? '已同意新分账' : '已确认'}`;
    $('split-policy').textContent = state.session?.split_policy === 'equal' ? '全单等额 AA，尾差精确到分。在同一付款账号核销权益，全员确认分享优惠金额，优惠券不会跨账号转移。' : '包括限定餐品券在内，订单优惠统一按餐费比例分享；配送均分，尾差到分。在同一付款账号用券，全员确认分享其金额，优惠券不会跨账号转移。';
    $('approval-note').textContent = reconciliationRequired() ? '下面保留原报价的确认记录，不能用于实付差额。请先在账单区按已核验实付提出新分账；超过预算或硬上限时需人工协商，不能强制增加应付。' : reconciliationProposed() ? isDemo() ? '订单已模拟支付。这次按钮仅模拟每位主人同意新分账，不代表真实成员授权；全员同意后发账单，不会再次下单。' : '订单已支付。这次只确认新的实付分账，每位主人须从自己的 Agent 同意当前分账版本；全员同意后发账单，不会再次下单。' : isDemo() ? '这些按钮模拟四位主人分别同意，仅用于演示，不能代表真实成员授权。' : '真实成员需要从自己的 Agent 确认同一版方案；发起人不能替成员批准。';
    const bills = array(best.participant_bills);
    const rows = members.map((person, index) => {
      const bill = bills.find(item => item.agent_id === person.agent_id);
      const card = el('div', 'approval-card'); const name = el('div', 'approval-name');
      name.append(avatar(person, index), el('strong', '', person.name));
      const pickedId = best.option_ids && typeof best.option_ids === 'object' && !Array.isArray(best.option_ids) ? best.option_ids[person.agent_id] : null;
      const picked = array(person.options).find(option => option.id === pickedId) || best.selected_options?.find?.(option => option.agent_id === person.agent_id);
      card.append(name, el('p', 'approval-selection', picked?.label || '本次确认的餐品配置'), el('strong', 'approval-amount', money(bill?.payable_cents)), el('p', '', reconciliationProposed() ? '新实付分摊 · 待本人同意' : reconciliationRequired() ? '原报价分摊 · 已失去实付效力' : receiptPlan() && paid() ? '已同意本次实付分摊' : ordered() ? '当前方案已锁定' : '预计分摊 · 实付后再对账'));
      for (const replacement of array(best.coupon_replacements).filter(item => item.agent_id === person.agent_id)) card.append(el('p', 'replacement-note', `基础编码 ${text(replacement.base_sku)} → 券餐品编码 ${text(replacement.product_sku)}。核对餐品 / 套餐配置一致${replacement.owner_confirmed === true ? '；已记录本机主人确认。' : '；仍需本人确认。'}`));
      const button = el('button', `approve-button${approved.has(person.agent_id) ? ' approved' : ''}`, reconciliationRequired() ? '原方案确认记录' : approved.has(person.agent_id) ? receiptPlan() ? '✓ 已同意新分账' : '✓ 已确认这一版方案' : isDemo() ? receiptPlan() ? `模拟 ${person.name} 同意新分账` : `模拟 ${person.name} 同意` : receiptPlan() ? '等待本人 Agent 确认新分账' : '等待成员 Agent 确认');
      button.disabled = busy || (ordered() && !reconciliationProposed()) || approved.has(person.agent_id) || !planHash() || !isDemo();
      button.addEventListener('click', () => mutate('/api/approve', { agent_id: person.agent_id, plan_hash: planHash() }, `${person.name} 的${receiptPlan() ? '新分账模拟同意' : '模拟批准'}已记录。`));
      card.append(button); return card;
    });
    $('approval-grid').replaceChildren(...rows);
    const allApproved = members.length > 0 && members.every(person => approved.has(person.agent_id));
    const trueCheckout = state.capabilities?.live_checkout === true && !isDemo();
    $('checkout-button').hidden = receiptPlan() || reconciliationStage();
    $('checkout-button').disabled = receiptPlan() || reconciliationStage() || busy || ordered() || !allApproved || !planHash() || (!isDemo() && !trueCheckout);
    $('checkout-button').textContent = state.session.status === 'submitting' ? '当选 Agent 正在提交…' : state.session.status === 'order_uncertain' ? '下单结果待核对' : ordered() ? isDemo() ? '已完成演示下单确认 ✓' : '下单请求已锁定 ✓' : isDemo() ? '模拟下单确认 →' : trueCheckout ? '交给当选 Agent 下单 →' : '真实下单尚未就绪';
    $('checkout-note').textContent = reconciliationStage() || receiptPlan() ? paid() ? '全员已同意新的实付分账，正式账单已生成。未创建第二个订单。' : '这里只确认分账。未全员同意之前不发送新的应收账单，也不会创建第二个订单。' : !isDemo() ? trueCheckout ? '所有主人从自己的 Agent 确认后，发起人将请求交给当选账号；创建订单在成员本机进行。' : '尚未连接完整的真实成员与下单流程，不允许真实下单。' : ordered() ? '演示方案已锁定，等待模拟支付与实际金额对账。' : allApproved ? '四位主人已模拟确认同一版方案，可以继续演示下单。' : '每位主人确认同一版方案后，才进入下单。';
  }
  function finalBills() {
    const settlement = state.settlement || state.session?.settlement || state.plan?.settlement;
    return array(settlement?.participant_bills || settlement?.bills || state.bills || bestPlan()?.participant_bills);
  }
  function renderBills() {
    const hasOrder = ['awaiting_payment', 'reconciliation_required', 'reconciliation_proposed', 'settled'].includes(state.session?.status);
    $('bill-section').hidden = !hasOrder; if (!hasOrder) return;
    const settlement = state.settlement || state.session?.settlement || state.plan?.settlement;
    const rows = paid() ? finalBills() : array(bestPlan()?.participant_bills);
    const actual = settlement?.actual_total_cents ?? settlement?.total_cents ?? state.session?.receipt?.total_cents ?? state.actual_total_cents;
    const total = paid() || reconciliationStage() ? cents(actual) ?? sum(rows, 'payable_cents') : bestPlan()?.total_cents;
    const original = cents(state.plan?.original_quote_cents) ?? (reconciliationRequired() ? bestPlan()?.total_cents : null);
    const tableTotal = reconciliationRequired() ? sum(rows, 'payable_cents') : total;
    $('bill-badge').textContent = reconciliationRequired() ? isDemo() ? '模拟已支付 · 分账需重确认' : '已支付 · 分账需重新确认' : reconciliationProposed() ? isDemo() ? '演示新分账待全员确认' : '新实付分账待全员确认' : paid() ? isDemo() ? '演示正式 AA 账单' : '正式 AA 账单' : isDemo() ? '等待模拟支付对账' : '等待下单主人支付';
    const description = el('div');
    description.append(el('h3', '', reconciliationRequired() ? isDemo() ? '模拟实付与原报价不同，需要重新分账。' : '实付与原报价不同，需要重新分账。' : reconciliationProposed() ? isDemo() ? '模拟实付已核验，等待每位主人同意新分账。' : '实付已经核验，等待每位主人同意新分账。' : paid() ? isDemo() ? '模拟支付已完成，账单已对齐。' : '已确认支付，账单已对齐。' : isDemo() ? '下单已模拟确认，等待实付金额。' : '订单已创建，等待下单主人支付。'), el('p', '', reconciliationStage() ? '订单已经支付。这次只处理分摊差额；预算与硬上限继续生效，全部主人再次同意后才发正式账单。' : paid() ? isDemo() ? '按演示实付金额结算，分摊合计与总金额一致。' : '按已支付收据结算，分摊合计与总金额一致。' : isDemo() ? '演示将按当前方案金额模拟支付，再生成正式 AA 账单；并未发生真实付款。' : '由下单成员在自己的 Agent 本机完成支付；确认已支付后，才生成正式 AA 账单。'));
    $('payment-content').replaceChildren(description, el('strong', 'payment-amount', money(total)));
    const reconciliationSummary = $('reconciliation-summary'); reconciliationSummary.hidden = !reconciliationStage(); reconciliationSummary.replaceChildren();
    if (reconciliationStage()) {
      reconciliationSummary.append(el('strong', '', reconciliationRequired() ? '先核对实付差额，再提出新分账。' : '新的分摊金额，等待全员确认。'), el('p', '', `${cents(original) !== null ? `原确认报价 ${money(original)}；` : ''}已核验实付 ${money(total)}。`));
      if (cents(original) !== null && cents(total) !== null) { const delta = total - original; reconciliationSummary.append(el('p', 'reconciliation-delta', delta > 0 ? `实付增加 ${money(delta)}，不能自动增加任何人的应付金额。` : delta < 0 ? `实付减少 ${money(-delta)}，也需要全员确认新的分摊。` : '总金额相同，但分摊依据发生变化，仍需全员重新确认。')); }
      reconciliationSummary.append(el('p', '', '超出任何成员预算或硬上限时，需人工协商解决；不会强制增加付款。'));
    }
    const wrap = el('div', 'bill-table-wrap'); const table = el('table', 'bill-table');
    const head = el('thead'), header = el('tr');
    for (const value of ['这位主人', receiptPlan() ? '餐费分摊基数' : '餐品原价', '分摊优惠', '配送分摊', reconciliationRequired() ? '原确认 AA' : reconciliationProposed() ? '新实付分摊（待确认）' : paid() ? isDemo() ? '演示实付 AA' : '实付 AA' : '预计应付']) header.append(el('th', '', value)); head.append(header);
    const body = el('tbody');
    for (const bill of rows) {
      const row = el('tr');
      for (const value of [bill.name || nameFor(bill.agent_id), money(bill.food_cents), cents(bill.discount_cents) !== null ? `−${money(bill.discount_cents)}` : '待核算', money(bill.delivery_cents), money(bill.payable_cents)]) row.append(el('td', '', value));
      body.append(row);
    }
    const foot = el('tfoot'), row = el('tr'), label = el('td', '', reconciliationRequired() ? '原方案分摊合计' : reconciliationProposed() ? '待确认新分摊合计' : paid() ? isDemo() ? '演示实付合计' : '实付合计' : '预计合计'); label.colSpan = 4; row.append(label, el('td', '', money(tableTotal))); foot.append(row);
    table.append(head, body, foot); wrap.append(table); $('bill-content').replaceChildren(wrap, el('p', 'mobile-bill-hint', '左右滑动，查看完整账单明细。'));
    $('settle-button').hidden = paid() || reconciliationStage();
    $('reconcile-button').hidden = !reconciliationRequired(); $('reconcile-button').disabled = busy || cents(actual) === null; $('settle-button').disabled = busy;
    $('settle-button').textContent = isDemo() ? '模拟完成支付并对账 ✓' : '让当选 Agent 核对支付 →';
    $('export-button').hidden = !paid();
    const outbox = paid() ? array(state.outbox) : [];
    $('outbox-content').replaceChildren(...outbox.slice(-membersCount()).map(message => {
      const item = el('div', 'outbox-item');
      item.append(el('strong', '', `${nameFor(message.agent_id)} · 本地收件箱`), el('span', '', message.message || (isDemo() ? '演示账单已准备好，等待成员 Agent 领取。' : '账单已准备好，等待成员 Agent 领取。'))); return item;
    }));
  }
  function membersCount() { return participants().length || 4; }
  function render() {
    const members = participants();
    $('mode-badge').replaceChildren(el('span'), document.createTextNode(isDemo() ? '虚构演示' : '真实 Agent 会话'));
    $('source-marker').textContent = isDemo() ? 'DEMO' : 'AGENTS';
    const sourceTitle = el('strong', '', isDemo() ? '先看看四个 Agent 怎么配合。' : '每位成员保留自己的凭证与选择。');
    $('source-note').replaceChildren(sourceTitle, document.createTextNode(isDemo() ? '下方为虚构场景，不会创建真实订单或支付。' : '本页只展示协作数据；未连接完整流程，不允许真实下单。'));
    $('participant-count').textContent = `${members.length} 位 Agent`;
    $('hero-count-note').replaceChildren(el('span', 'tiny-grid', '✣'), document.createTextNode(`从 ${members.length || 4} 份需求，到 1 张清楚的 AA 账单。`));
    if (members.length) $('participant-grid').replaceChildren(...members.map(participantCard));
    else {
      const empty = el('div', 'plan-empty'); empty.style.gridColumn = '1 / -1'; empty.style.minHeight = '150px';
      empty.append(el('h3', '', loaded ? '这一桌还没有成员。' : '正在等待 Agent 入桌…'), el('p', '', '选择一个虚构场景，试试四个 Agent 怎样拼单。')); $('participant-grid').replaceChildren(empty);
    }
    for (const button of document.querySelectorAll('[data-scenario]')) { button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario)); button.disabled = busy || !isDemo() || (ordered() && !paid()); }
    const stage = state.session?.status;
    const activeStep = paid() || stage === 'awaiting_payment' || reconciliationStage() ? 4 : stage === 'approved' || bestPlan() ? 3 : ['ready', 'quoting', 'quote_incomplete'].includes(stage) ? 2 : 1;
    for (const step of document.querySelectorAll('[data-step]')) {
      const number = Number(step.dataset.step); step.classList.toggle('active', number === activeStep); step.classList.toggle('done', number < activeStep || paid());
    }
    $('relay-title').textContent = reconciliationRequired() ? '实付已经核验，原分摊需要重新确认。' : reconciliationProposed() ? '等待每位主人确认新的实付分账。' : paid() ? isDemo() ? '这一桌的演示账单已经算明白。' : '这一桌的账单已经算明白。' : state.session?.status === 'submitting' ? '下单请求已交给当选 Agent。' : state.session?.status === 'order_uncertain' ? '下单结果未确认，请当选 Agent 核对订单。' : ordered() ? isDemo() ? '方案已锁定，进入模拟支付对账。' : '订单已创建，等待下单主人支付。' : bestPlan() ? '价格算好了，接下来让主人确认。' : '把需求和权益交给 Agent。';
    $('relay-description').textContent = reconciliationStage() ? '只核对已支付订单的分账，不会再下单；预算与硬上限继续生效。' : paid() ? isDemo() ? '账单按演示实际金额结算，并写入每个成员的本地收件箱。' : '账单按已支付收据结算，等待各位成员 Agent 领取。' : bestPlan() ? '在主人允许的餐品选项中逐个账号比价，确认的是同一版方案与分摊。' : '先共享近期偏好，再收集本次需求，逐个账号比较可用权益。';
    $('relay-button').disabled = busy || ordered();
    if (!busy) $('relay-button').textContent = reconciliationStage() ? '进入实付分账确认 ↓' : ordered() ? '这一桌已接力完成 ✓' : isDemo() ? bestPlan() ? '重新收集并比价 ↻' : '让 Agent 接力 →' : members.length && members.every(person => person.status === 'collected') ? bestPlan() ? '重新核价 ↻' : '让 Agent 比价 →' : '请成员 Agent 收集数据 →';
    $('reset-button').disabled = busy || !isDemo() || (ordered() && !paid());
    renderPlan(); renderEvents(); renderApprovals(); renderBills();
  }
  async function relay() {
    if (busy || ordered()) return;
    setBusy(true, '正在收集偏好与需求…'); announce('');
    try {
      if (!participants().length) { await request('/api/demo', { scenario }); await refresh(); }
      if (!isDemo() && !participants().every(person => person.status === 'collected')) {
        await request('/api/collect', {}); await refresh();
        announce('已向成员自己的 Agent 发出收集请求。等每位主人提交需求与权益后，再点比价。');
        return;
      }
      if (isDemo()) { await request('/api/collect', {}); await refresh(); }
      $('relay-button').textContent = '正在逐个账号比价…';
      await request('/api/optimize', {}); await refresh();
      announce(isDemo() ? '方案已生成。接下来，请四位主人分别确认。' : '候选方案已交给各账号 Agent 实时核价。全部返回后，再由每位主人确认。');
    } catch (error) { announce(error.message, true); }
    finally { setBusy(false); }
  }
  for (const button of document.querySelectorAll('[data-scenario]')) button.addEventListener('click', async () => {
    if (busy) return; scenario = button.dataset.scenario;
    await mutate('/api/demo', { scenario }, `已建立“${scenarioLabels[scenario]}”四人虚构场景。`);
  });
  $('relay-button').addEventListener('click', relay);
  $('checkout-button').addEventListener('click', () => { if (reconciliationStage() || receiptPlan()) return; mutate('/api/checkout', { plan_hash: planHash() }, isDemo() ? '演示下单已确认。下一步是模拟支付与 AA 对账。' : '下单请求已交给当选 Agent。等待该成员本机确认创建结果。'); });
  $('settle-button').addEventListener('click', () => { if (reconciliationStage() || paid()) return; mutate(isDemo() ? '/api/settle' : '/api/payment-status', {}, isDemo() ? '模拟支付已对账，正式演示账单已回传到各个本地收件箱。' : '已请当选 Agent 查询订单支付状态。确认已支付前不生成正式账单。'); });
  $('reconcile-button').addEventListener('click', () => { if (!reconciliationRequired()) return; mutate('/api/reconcile', {}, '新的实付分账已提出。每位主人再次同意后才发送正式账单，不会再下单。'); });
  $('reset-button').addEventListener('click', () => mutate('/api/reset', {}, '演示已重置。可以邀请 Agent 再接力一次。'));
  function clearInvites() {
    invites = []; $('invite-list').replaceChildren(); $('invite-section').hidden = true;
  }
  async function copyPrivateInvite(invite) {
    const payload = JSON.stringify({ ...invite, coordinator_url: location.origin }, null, 2);
    let copied = false;
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(payload); copied = true; } catch {} }
    if (!copied) { const area = el('textarea'); area.value = payload; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select(); copied = document.execCommand('copy'); area.remove(); }
    $('session-form-status').textContent = copied ? `${nameFor(invite.agent_id)} 的个人邀请已复制，请只给对应的主人。` : '复制未成功，可以使用单独下载邀请。';
  }
  function downloadPrivateInvite(invite) {
    const blob = new Blob([JSON.stringify({ ...invite, coordinator_url: location.origin }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = el('a'); link.href = url;
    link.download = `agent-invite-${invite.agent_id.replace(/[^a-zA-Z0-9_-]/g, '')}.private.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('session-form-status').textContent = `${nameFor(invite.agent_id)} 的邀请已下载，请单独交给本人。`;
  }
  function renderInvites() {
    $('invite-section').hidden = invites.length === 0;
    $('invite-list').replaceChildren(...invites.map(invite => {
      const card = el('div', 'invite-card'); card.append(el('strong', '', nameFor(invite.agent_id)), el('span', '', '独立的成员邀请'));
      const secret = el('input', 'invite-secret'); secret.type = 'password'; secret.value = invite.secret; secret.readOnly = true; secret.autocomplete = 'off'; secret.setAttribute('aria-label', `${nameFor(invite.agent_id)} 的邀请码（默认隐藏）`); card.append(secret);
      const actions = el('div', 'invite-actions');
      const copy = el('button', '', '复制个人邀请'); copy.type = 'button'; copy.addEventListener('click', () => copyPrivateInvite(invite));
      const download = el('button', '', '单独下载给本人'); download.type = 'button'; download.addEventListener('click', () => downloadPrivateInvite(invite)); actions.append(copy, download); card.append(actions); return card;
    }));
  }
  async function createRealSession(event) {
    event.preventDefault(); if (busy) return;
    const status = $('session-form-status'); status.classList.remove('error'); status.textContent = '';
    try {
      const members = $('members-input').value.trim().split(/\r?\n/).filter(line => line.trim()).map(line => {
        const match = /^([a-zA-Z][a-zA-Z0-9_-]{0,31})[\s,，|]+(.{1,40})$/.exec(line.trim());
        if (!match) throw new Error('每行请填一个英文 Agent 标识，再空一格填写姓名。');
        return { agent_id: match[1], name: match[2].trim() };
      });
      if (members.length < 2 || members.length > 8 || new Set(members.map(member => member.agent_id)).size !== members.length) throw new Error('请填写 2–8 位成员，且 Agent 标识不能重复。');
      const body = { store_id: $('store-input').value.trim(), service_mode: $('service-input').value, fulfillment_key: $('fulfillment-input').value.trim(), split_policy: $('split-input').value, participants: members };
      if (!body.store_id || !body.fulfillment_key) throw new Error('请填写共同门店编号和地点别名。');
      setBusy(true, '正在建立真实成员邀请…'); $('create-session-button').disabled = true;
      if (isDemo() && paid()) await request('/api/reset', {});
      const response = await request('/api/session', body);
      if (!Array.isArray(response.invites) || response.invites.length !== members.length) throw new Error('成员邀请未完整返回，请重试创建；不要分享不完整邀请。');
      invites = response.invites.map(invite => ({ agent_id: invite.agent_id, secret: invite.secret, session_id: invite.session_id }));
      await refresh(); renderInvites();
      status.textContent = '真实会话已建立。先把每份邀请单独交给对应主人，再等待各自 Agent 连接。';
      $('invite-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
      announce('真实会话已建立。发起人不接收成员的麦当劳 Token。');
    } catch (error) { status.classList.add('error'); status.textContent = text(error.message); }
    finally { $('create-session-button').disabled = false; setBusy(false); }
  }
  $('show-session-form').addEventListener('click', () => { $('session-form').hidden = false; $('store-input').focus(); });
  $('session-form').addEventListener('submit', createRealSession);
  $('invite-done').addEventListener('click', () => $('integration-dialog').close());
  function showIntegration() { $('integration-dialog').showModal(); }
  for (const id of ['integration-button', 'integration-button-bottom']) $(id).addEventListener('click', showIntegration);
  for (const id of ['close-dialog', 'dialog-done']) $(id).addEventListener('click', () => $('integration-dialog').close());
  $('integration-dialog').addEventListener('click', event => { if (event.target !== $('integration-dialog')) return; const rect = $('integration-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('integration-dialog').close(); });
  render();
  setInterval(() => { if (loaded && !busy && !document.hidden && !isDemo()) refresh().catch(() => {}); }, 4000);
  refresh().catch(error => announce(error.message && /[\u4e00-\u9fff]/.test(error.message) ? error.message : '尚未连接本机协作服务。请先按使用说明启动服务。', true));
})();

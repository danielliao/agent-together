# 每个成员自己的 Agent 接入

成员 Agent 运行在主人控制的电脑/环境。麦当劳 Token 只用于它连接官方 `https://mcp.mcd.cn`，不发给发起人、其他 Agent、协调服务或聊天。协调器只收到主人允许的餐品需求、近期频次摘要、优惠别名、报价和账单回执。

公开示例都是占位符；这份说明不代表已经用多个真实账号完成联调。单机虚构演示、真实只读核价、本人创建待支付订单、本人实际支付是不同阶段。

## 准备本机设置

需要 Node.js 22 或更新版本。复制 `examples/member-profile.example.json` 到被忽略的 `work/`，文件名例如 `work/me.private.json`，在本机编辑。真实 profile、券映射和订单台账都不能公开提交。

```sh
mkdir -p work
cp examples/member-profile.example.json work/me.private.json
chmod 700 work
chmod 600 work/me.private.json
```

`agent_id` 填发起人为你创建的同一局成员编号；`fulfillment_key`、当前门店和取餐方式须与同局一致。`options` 只填写主人愿意接受的餐品配置；所有 `sku` 必须来自这次当前门店 `query-meals` 的 `data.meals` 键。历史订单的产品 code、子项 code、餐品名字不是当前菜单可下单标识，不要直接复用。

每人声明 1–4 项允许配置。`budget_cents` 必须由主人明确填写，单位分；可另填 `max_pay_cents` 作为本人分账的硬上限。缺失预算或无效上限会报错，不会默认为无限预算。

价格由当前菜单提供估算，再用每个候选付款人的 `calculate-price` 返回核验。普通一起点餐使用 `beType=1` 到店、`beType=2` 外送；不要把朋友拼单当作 `beType=6` 企业团餐。到店 `takeWayCode` 必须对应当前核价的 `takeWayList.code`；公开示例未确定其他取餐字段时，程序会停止而不是猜。外送需把 `addressId` 填为**付款主人账号自己的**地址 ID；其他账号的 ID 不能代用。

`history.shared` 默认 `false`。主人明确愿意分享时才改为 `true`：分享的只有最近最多 10 笔返回记录中的已完成样本数、餐品名、出现订单数和样本范围；不会分享完整订单、地址、门店、手机号、金额、精确时间或原始产品标识。

## 两个不同的本机凭证

在自己的终端里设置 `MCD_MCP_TOKEN`。不要把凭证写进命令参数、示例文件或聊天。macOS 默认 zsh 可以隐藏输入：

```sh
read -rs 'MCD_MCP_TOKEN?麦当劳 MCP Token（仅本机）：'
export MCD_MCP_TOKEN
```

发起人给你的**成员邀请密钥**填入另一个变量；它用于同一局的 Agent 身份验证，绝不能填麦当劳 Token：

```sh
read -rs 'TOGETHER_AGENT_SECRET?本局成员邀请密钥：'
export TOGETHER_AGENT_SECRET
```

没有麦当劳 Token 时，本机成员命令会明确报 `missing_token`，不会用演示代替真实读取。没有独立成员邀请密钥则不会连接协调服务。主人设置与 Token 都留在本机。

## 读取、加入同一局、确认当前方案

先单独读取，终端输出的是允许对外分享的白名单快照：

```sh
node scripts/member.mjs collect --profile work/me.private.json
```

同一电脑上的独立成员进程可连接发起人的本机服务：

```sh
node scripts/member.mjs worker --profile work/me.private.json --coordinator http://127.0.0.1:4380
```

不同电脑不能访问对方的 `127.0.0.1`。需要一个已经配置好的 HTTPS 协调入口、适配本机服务器 Host 检查的网关和每人独立邀请密钥；本项目默认启动命令仅监听本机，不会自动公开公网入口。worker 只接受 HTTPS 或 HTTP 回环地址，不会把凭证跟随跳转发送到其他站点。

worker 领取 `collect`、`quote`、`proposal`、`checkout`、`payment` 和 `bill` 任务。看到 proposal 时，它只显示**本人**餐品、应付金额、下单主人、券餐品替换、状态、到期时间和方案哈希，不自动批准。

在另一终端使用同一 profile 和同局邀请密钥，明确批准刚看过的当前哈希。运行后仍需主人再次粘贴该哈希确认：

```sh
node scripts/member.mjs approve --profile work/me.private.json --coordinator http://127.0.0.1:4380 --plan-hash CURRENT_64_CHARACTER_SHA256
```

approve 把当前哈希批准写入本机权限为 600 的私有台账，再向协调器发送本人批准。运行中的 worker 在 checkout 时重新读取台账；方案内容、报价或哈希变化后旧批准不能沿用。全员同意并由付款主人本机确认后，该 Agent 再次核价；变价返回 `PRICE_CHANGED`，不会创建订单。

可以对发起人下发的报价任务 JSON 单独核价：

```sh
node scripts/member.mjs quote --profile work/me.private.json --input work/quote-task.private.json
```

checkout 在本机台账里先记录一次尝试，再只调用一次 `create-order`。超时或结果不明时保留 `outcome_unknown`，不会自动重试；须主人到本人账号核实。不要删除台账或遗留锁文件后重新创建同一单。

同一局或同一门店、履约范围、预约时间和餐品篮子的未决/待付记录，还会阻止换哈希或重开一局绕过防重。主人已在本人账号找到这次订单时，可以在本机交互确认并补充订单号，查询其实际状态：

```sh
node scripts/member.mjs reconcile --profile work/me.private.json --reference LOCAL_ORDER_REFERENCE --order-id OWNER_VERIFIED_ORDER_ID
```

若创建超时且没有任何返回订单号，主人确实核实完全没有创建订单后，才可使用 `--confirm-absent` 代替 `--order-id`。终端会要求本人再次确认引用，台账保留人工核实记录；这不是官方已支付凭据，也不会自动重试原创建。已有订单号的记录不能如此解除，只能查询其明确完成/取消状态。

创建成功只代表 `awaiting_payment`。支付链接留在本机，付款主人用自己的终端查看：

```sh
node scripts/member.mjs payment --profile work/me.private.json --reference LOCAL_ORDER_REFERENCE
```

主人在官方支付页自行支付。之后由发起人请求同步支付状态；当前首版只把明确 `订单已完成` 且金额字段完整的详情作为已付凭据，未知、制作中或数字状态都不会自动判定为已付。账单发回每人的 Agent，金额精确到分；账单送达不代表已执行个人转账。

如果实付与原报价有差额，发起人会暂停 AA，生成带实际收据金额的新分账方案、新哈希，并重新让每个成员确认。worker 会标注 `settlement_only: true`，展示本人食品金额、优惠分摊、配送分摊及最终应付；此时必须使用：

```sh
node scripts/member.mjs approve --profile work/me.private.json --coordinator http://127.0.0.1:4380 --plan-hash NEW_RECEIPT_PLAN_SHA256 --settlement-only
```

终端明确提示“仅确认已支付订单分账，不授权再次创建”。本机台账记为 `purpose: settlement`，不能拿来再次创建订单。全员同意后只发送最终 AA 账单，不再调用 checkout。旧台账中未注明用途的批准也不能继续作为创建订单授权。

## 优惠券与权益的明确边界

`query-my-coupons` 的公开示例是 Markdown；`query-store-coupons` 给券标识和券商品映射，但没有通用满减门槛或叠加 schema。程序不会从券标题猜满减。原始 `couponId`、`couponCode` 只存本机台账，对外使用随机别名。

主人可用本机 profile 的 `selected_coupon_ids` 选择最多可共享的候选券；券与权益总共最多 8 个。不填明确选择时，只共享有限摘要并标明范围；保留原始券池在本机，不把有限候选说成全账户全局最优。公开示例空数组表示尚未选券。

需真实测试一张券时，主人在 `coupon_bindings` 中用本机原始券 ID 指定**一位成员、一项配置的一件餐品**：

```json
{
  "LOCAL_COUPON_ID": {
    "agent_id": "member-a",
    "option_id": "choice-a",
    "item_index": 0,
    "base_productCode": "CURRENT_BASE_MENU_CODE",
    "productCode": "CURRENT_COUPON_PRODUCT_CODE",
    "replacement_confirmed": true
  }
}
```

`productCode` 必须来自该券官方 `products`，`base_productCode` 必须等于候选原餐品编码。如果两码不同，须明确同意对应替换；共享的绑定摘要会让发起人及餐品主人看到替换并确认。程序不会给整篮子挂同一张券，也不猜多份核销规则。明确绑定的未知规则券标 `quote_only`，由本人账号单券实时报价，不编造本地折扣。

`coupon_rules` 里的已知数字规则只作为主人声明的估算，须包含有效期、门店/履约/SKU 适用范围。包含积分消耗或额外购卡支出的规则不能当免费优惠。麦金卡/早餐卡通常通过本人菜单的当前价和 `discountType` 体现；没有独立工具完整列出每张权益卡。未知权益只显示摘要；不会领券、扣积分、买新卡或转移他人的权益。

特制选项要通过 `query-meal-detail` 的当前 `modification.items.values` 校验编码、数量及 key。公开示例未提供套餐 `rounds` 的完整结构，因此首版遇到自选 `roundList` 会明确停止，不宣称已确认换菜能力。

## 参数合约校准

每次连接先读取官方 `tools/list`，按其 inputSchema 确认类型及必填项；公开工具指南见 [官方使用指南](https://github.com/M-China/mcd-mcp-server)、[详细文档](https://open.mcd.cn/mcp/doc)。`profile.tool_args[工具名]` 只用于本机补充**已在当前 schema 中确认的同名字段**；不支持通过猜别名绕过合约。

不把只读探测当成真实下单/支付验收，也不公开包含原始券码、地址、订单号、支付链接的响应。完成多个本人账号的只读核价后，才可声称这个范围已联调。默认本机台账在被忽略的 `work/`，目录权限 700，文件权限 600；Token 永远不写入台账。

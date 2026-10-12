# Agent 协作协议 v1

这是本项目的认证 JSON 任务协议，不冒称官方 A2A 实现。协调者为每个成员签发单独的随机邀请凭证；成员通过 bearer 凭证访问自己的任务收件箱。邀请凭证不等于 MCP Token，MCP Token 永不发给协调者。

发起人通过同源 HttpOnly/SameSite=Strict 会话访问 `/api/session`（建局并生成邀请）、`/api/collect`（发收集任务）、`/api/optimize`（逐候选本人账号核价）、`/api/checkout`（全员确认后的当选 Agent 下单任务）、`/api/payment-status`（请求当选 Agent 查支付）。本机发起人可查看合计和每人分账；真实成员只能用自己凭证确认。

成员接口：

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | /api/agent/tasks?agent_id=… | 本人 collect/quote/proposal/checkout/payment/bill 任务 |
| POST | /api/agent/snapshot | `{agent_id,snapshot}`，本人需求、允许配置、可分享历史摘要与脱敏权益 |
| POST | /api/agent/result | `{agent_id,task_id,result}` 或 `{agent_id,task_id,error:{code}}` |
| POST | /api/agent/approve | `{agent_id,plan_hash}`，本人明确确认当前核价方案 |
| POST | /api/agent/ack | `{agent_id,task_id}`，确认非业务收件消息 |

每个请求带 `Authorization: Bearer <本人的 TOGETHER_AGENT_SECRET>`。请求中的 agent_id 必须与凭证匹配，协调者不能通过管理接口替真实成员确认。GET 收件箱不会丢弃任务；只有完成/回执才删除。重复结果不二次处理。任务与方案 hash 绑定；改需求、重新报价使旧确认失效。

同一轮 collect 请求幂等，每位成员只排一次；每次最多领取 20 个任务。重新核价后，已处理或失效任务的旧回复被本人身份幂等接受并忽略，不会终止成员的后续工作。

已核实支付但实付有差额时，发起人可 `POST /api/reconcile` 提出新账单。状态变为 `reconciliation_proposed`，每人确认新的分账哈希后直接发账单，不再下单。此时不要求原券快照仍有效，因为消费已经发生；仍检查每人预算和硬上限。超限部分不能强制分账，须各主人自行协商。

正式 bill 任务只包含该成员自己的 bill、付款人标识、拼单 ID、合计和状态，不含别人的完整订单、卡券或支付链接。`transfer_status=untracked` 明确未核验转账。

本机服务绑定 127.0.0.1，拒绝异常 Host、跨源写入和无凭证读数。跨设备联调需部署 HTTPS 反向代理到此服务，正确配置固定源/Host 验证，并让成员从各自设备轮询；项目不自动建立公共隧道。MCP Endpoint 仅允许官方 HTTPS 地址；回环地址仅供协议测试。

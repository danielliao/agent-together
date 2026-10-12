# 麦当劳 MCP 接入与验证范围

官方 MCP：`https://mcp.mcd.cn`，Streamable HTTP，成员本机请求携带 `Authorization: Bearer ${MCD_MCP_TOKEN}`。每个成员拥有自己的一份连接；发起人不收 Token。先 initialize、notifications/initialized、tools/list，再按当前 inputSchema 校验参数。协议支持 JSON/SSE、会话和有限分页；下单不自动重试。

| 工具 | 用途 |
|---|---|
| order-list / query-order | 本人近期历史和付款后的本人订单状态核验 |
| query-meals / query-meal-detail | 当前门店 SKU、价格、会员优惠、主人允许的套餐替换 |
| query-store-coupons / query-my-coupons | 本人门店券及本人卡券摘要；未知规则不自动当满减券 |
| query-my-account | 积分信息，只作资源摘要，不直接折算现金 |
| calculate-price | 每个候选下单账号自己的实时核价，返回金额直接作为实付 |
| create-order | 当选本人账号在具体方案确认后提交一次，返回本人支付链接 |

## 已核对官方公开文档

2026-10-12 核对 [官方 GitHub 工具列表](https://github.com/M-China/mcd-mcp-server) 和 [详细工具文档](https://open.mcd.cn/mcp/doc)。当前公开文档资源为 `https://open.mcd.cn/static/js/index.42407507.025ffc2e.chunk.js`；运行时仍以 tools/list 的 schema 和实际响应为准。

- `order-list` 无文档入参，返回 `success/code/data.list`；只把 `orderStatus=订单已完成` 计入历史。商品 `orderProductList` 和套餐 `comboItemList` 同单去重，子项存在时避免父/子重复计数。只分享允许的名称、出现订单数、样本完成数与排除数；不传订单号、地址、店名、时刻、金额、备注、支付信息。
- 历史 `productCode` 不代表当前可售 SKU，必须再用当前门店 `query-meals`/`query-meal-detail` 确认。详情子项字段与历史不同，不能盲目通用适配。
- `query-my-coupons` 文档展示 Markdown，不视为稳定结构化满减规则。`query-store-coupons` 给 `data[]` 的 `couponId/couponCode/products[]`，没有承诺门槛和叠加。券码留在所属成员；向协调者传 opaque alias 与主人筛选后可解释规则。
- `query-meals` 的 `data.meals[code]` 给 `currentPrice/originalPrice/discountType`；既有卡价格通过本人账号核价生效。新购卡 `withOrder` 需要单独同意并计入全价，默认不购买。
- `calculate-price` 的 `items` 是商品列表，`couponId/couponCode` 放在对应商品项。`modification/roundList` 必须保留当前门店详情核验后的实际配置，不能擅自换菜。
- `calculate-price` 的 `data.price` 为最终总额（分），`deliveryPrice` 为配送实付（分）。不再减一次 `discount`。配送、餐具及其他合法费用已经在总价内，分账要守恒。
- `create-order` 外送使用下单账号自己的 `addressId`，到店使用本次可用 `takeWayCode`。返回 `payH5Url` 留在该成员本机；公开工具没有直接支付、AA 代收、转账或跨账号合券能力。
- 官方 `query-order` 金额示例是十进制元字符串，与 calculate-price 整数分不同；只接受明确可识别的支付状态和字段，字段漂移停止适配。

## 对最优价的定义

离线演示精确枚举明确规则集合。真实模式将同一门店、时间和履约目标下，主人允许的餐品配置、可明确匹配到商品的券，发送到各账号实时核价。任何未完成、失败、过期的候选都会阻止“已核验最优”的结果。未知券不假定门槛、可转让或叠加；最终最优范围只限本次枚举，不代表所有未知券和全菜单最优。

已明确绑定到某位成员接受配置的未知数字规则券，可作为 `quote_only` 单券候选由官方报价。绑定中的基础商品和券商品不同，需要显式确认，并在该餐品主人的 proposal 中展示。未知券之间不自动组合。离线模型遇到会影响优惠分配的重叠限量绑定时拒绝精确声明，要求限定绑定或校准官方定价模型。

## 验证声明

2026 年 10 月 12 日 10:28（北京时间），用户在本项目独立本机验证页自行提供凭据。`scripts/verify.mjs` 使用本项目的 `src/mcp.mjs` 与 `src/history.mjs` 实际连接官方服务，initialize、tools/list、order-list、query-my-coupons、query-my-account 均成功；三项业务查询均确认官方业务成功结构，近期历史在内存完成摘要处理。验证记录只保留时间、工具名、成功状态和范围，不保留 Token、账号、余额、餐品、数量、完整历史、券码、地址或订单号。

该验收覆盖本项目单账号只读链路，未执行领券、兑换、购卡、创建订单或支付。多账号近期订单读取、真实拼单核价、订单创建和支付仍待各成员在本人设备配置后验证，不能把这次只读验证或四人虚构演示写成完整多人现场联调。

另有 68 项本地自动测试，包含协议 stub、历史合成样例、分账、身份、确认、防重与验证页边界。公开项目仅放虚构数据，没有成员 Token 或真实订单；未沿用「麦麦小剧场」的联调记录作为本项目证据。

`CONTEST_DECLARATION.md` 为活动官方原文，保留原权利。已于 2026 年 10 月 12 日 10:37（北京时间）提交[参赛申请 #485](https://github.com/M-China/mcd-developer-innovation-challenge/issues/485)，等待官方确认；源码发布和本次验证不替代官方审核。

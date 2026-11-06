# pi.dev model cards：数据形态与交互接入调研

核验日期：2026-11-06。本仓基线：`2d8fb55`，插件 1.2.2、测试依赖 Pi 1.4.0。另查阅本机 Pi 1.5.0 的公开 SDK 声明与文档；本调研不是 Pi 1.5.0 适配或全量兼容性验证。

## 结论

`pi.dev/models` 的 model card 是可浏览的模型目录详情页，不是以长篇描述、评测分数为主的训练模型报告。它展示身份、API、上下文/输出限制、输入模态、推理支持、价格、配置示例、有效 compat、成本估算和其他 Provider 的同款模型。

**可以直接使用官方公开 JSON catalog，不需要抓 HTML。** 目录用于提供模型元数据与配置参考；不能证明某个代理端点实际支持相同协议、价格或能力，也不能替代端点自己的可用模型列表。

本次无凭证执行 12 个 HTTP 请求，并直接把响应传入本仓的 `normalizeEndpointModels()`。没有读取用户配置/密钥，没有调用付费模型，没有修改插件运行时代码。

## 1. 官方来源与数据来路

- [目录页面](https://pi.dev/models)；[实际查看的 DeepSeek V4 Pro 卡片](https://pi.dev/models/deepseek/deepseek-v4-pro)。
- [官方 catalog 构建说明][catalog-readme]：汇集 models.dev v2、OpenRouter、Vercel 等来源，再应用 Pi 的 Provider 定义、API compat、模型家族规则、修正与补充；不是 models.dev 原始数据的简单镜像。
- [DeepSeek 定义][deepseek-source]有人工维护的数据和官方价格来源，并明确指出当前 cost schema 无法表达分时优惠。
- [Pi/pi.dev 共用的目录协议][protocol]定义版本选择和两种 JSON 表示；[Pi 的远端目录客户端][remote-client]实际请求下面的公开接口。
- [发布工作流][publish-workflow]表明目录独立生成和发布，不能把 npm 包版本等同于目录修订版本。

`earendil-works/pi.dev` 仓库公开 GitHub API 返回 404，未获得网站服务端/页面生成源码。因此页面派生行为以浏览器观察为依据，目录协议以 Pi 公共源码和实际 HTTP 响应交叉核验。

## 2. 访问入口与数据形态

以下 `V` 是**宿主 Pi 的版本**，不是本插件版本。

| 请求 | 响应形态 | 用途 |
| --- | --- | --- |
| `GET https://pi.dev/api/models/providers?pi-version=V` | `string[]` | Provider ID 列表 |
| `GET https://pi.dev/api/models?pi-version=V` | `Record<provider, Record<modelId, ChatModel>>` | 全量聊天目录 |
| `GET https://pi.dev/api/models/providers/{provider}?pi-version=V` | `Record<modelId, ChatModel>` | 一个 Provider 的聊天目录 |
| 上述模型接口加 `&types=chat,image,classifier` | 全量为 `Record<provider, AnyModel[]>`；单 Provider 为 `AnyModel[]` | 同时保留不同操作类型 |

**`types` 目前选择表示方式，不执行类型过滤。** 实测 OpenRouter 的 `?types=chat` 仍返回 391 个 chat、66 个 image、35 个 classifier。只做聊天配置时可不传 `types`；消费 typed 表示时必须自己过滤 `(model.type ?? "chat") === "chat"`。

同一 Provider 下同一个 ID 可以对应不同操作。本次发现 6 组跨类型重复身份，例如 `openai/gpt-6-luna` 同时有 chat/classifier。混合目录索引必须使用 `(type, provider, id)`；卡片 URL 中的 slug 也不是可靠的 API model ID。

### 本次快照

- 43 个 Provider；1,616 个 chat、66 个 image、59 个 classifier，共 1,741 条。
- 全量聊天 JSON 951,138 字节，typed 全量 JSON 957,611 字节；按 Provider 获取更轻量。
- 目录 revision：`sha256-5ff8a791cbfd41aff8c125f23ff37d59d03ee4bcfd9c2acdf390d562a0d3acd4`。
- 本次返回的最低 Pi 版本为 `1.2.1`；这不是未来目录永久不变的兼容范围。
- 上述数字、价格与字段覆盖率都是核验时间的快照，不能硬编码。

### 单条聊天模型示例

以下摘自实际响应；省略了 `compat` 和 `thinkingLevelMap`，完整样本保存在 [evidence.json](research/pi-dev-model-cards/evidence.json)。

```json
{
  "type": "chat",
  "provider": "deepseek",
  "id": "deepseek-v4-pro",
  "name": "DeepSeek V4 Pro",
  "api": "openai-completions",
  "baseUrl": "https://api.deepseek.com",
  "reasoning": true,
  "input": ["text"],
  "contextWindow": 1000000,
  "maxTokens": 384000,
  "cost": {
    "input": 1.32,
    "output": 3.96,
    "cacheRead": 0.044,
    "cacheWrite": 0
  }
}
```

| 字段 | 含义及使用限制 |
| --- | --- |
| `provider`, `id`, `name`, `type` | 来源、实际请求 ID、展示名、操作类型；展示名不应用作身份匹配 |
| `api`, `baseUrl`, `headers` | 该 Provider 的连接/协议信息；不能据此覆盖用户代理的连接设置 |
| `reasoning`, `thinkingLevelMap` | 推理支持及 Pi level 映射；布尔值不足以推导全部可选等级，`null` 与字段缺省不可合并处理 |
| `input` | 输入模态；image 模型另有 `output`，不等于聊天模型支持生成图片 |
| `contextWindow`, `maxTokens` | token 数；不要分别混淆上下文容量与最大输出 |
| `cost` | USD / 百万 token，含输入、输出、cache read/write；可有 `tiers[].inputTokensAbove` 分档，不能只显示基础价格而隐藏分档 |
| `inputLimits` | 请求/图片限制及 resize 配置；不等于宿主已对所有限制执行强制校验 |
| `promptCache` | `short` / `long` 保留时间，单位秒；字段缺省不是零 |
| `compat` | Provider/API/模型相关的显式兼容覆盖；缺省不等于 false，也不等于已验证支持 |

当前聊天快照还包含少量 `lab`、`enabled`、`providers`、`free` 等额外键。远端字段不能整对象复制到 `models.json`；本仓应按目标配置 schema 投影白名单，再校验。catalog 价格只能作参考，0 不能一概解释为服务免费；订阅、代理加价、分时费率和实际账单另有规则。

### 卡片展示值不等于 JSON 显式值

DeepSeek V4 Pro 卡片的 Compatibility flags 声明是 “Effective values after applying Pi's API defaults and model overrides”。例如页面显示 `supportsReasoningEffort = Yes`，但本次 API `compat` 和页面配置示例均未显式写这个键。

因此应区分：**catalog 显式值、宿主当前模型元数据、用户显式覆盖、API 默认/自动检测**。不要将网页的所有有效值固化成用户覆盖，也不要直接把 registry 对象称作“所有 API 默认值均已展开”。

## 3. 版本选择、缓存与失败处理

- 明确的 `?pi-version=V` 优先于 `User-Agent: pi/V`；没有版本且没有可识别 Pi UA 时使用默认 revision。不要让插件版本或普通 Node UA 意外决定宿主兼容目录。[protocol]
- 无认证 GET 实测成功；响应有 `Access-Control-Allow-Origin: *`。不需要也不应附加用户 Provider 的 API key/header。
- 响应提供 `ETag`、`Last-Modified`、`x-pi-model-catalog-revision`、`x-pi-model-catalog-minimum-version`。实测 `If-None-Match` 返回 **304 空 body**，不能对 304 调 `.json()`。
- 本次 HTTP 缓存为 `public, max-age=60, s-maxage=60`；Pi 普通远端 overlay 的应用层刷新间隔为 **4 小时**，这是两层不同策略。
- Pi 客户端以 bundled catalog 为基础，只叠加比 bundled 数据更新的远端数据，并能恢复离线缓存。不要把远端列表看成对 bundled 列表的无条件整体替换。[remote-client]
- Pi 的 personalized catalog 路径另有凭证相关逻辑，不能把普通 overlay 的 4 小时策略推广到所有 Provider。[remote-client]
- 实测非法版本、空 `types` 返回 400；未知 Provider、没有兼容目录的旧版本返回 404。失败应保留已有配置/可用缓存，显示不可用或过期状态，不能静默去掉版本约束重试默认目录。
- 若插件独立获取，缓存身份至少区分 Provider、宿主版本和 JSON 表示方式；只有本地存在对应 body 时才发送条件请求。请求有超时，限制响应大小/结构，离线不阻塞编辑。

## 4. 两种使用方式

### A. 读取宿主现有目录：用于本机模型列表与当前元数据

Pi 1.5.0 的公开 `ModelRegistry` 有以下同步读取接口；实际使用应由当前宿主类型约束，不能导入编码绝对路径的内部模块。[registry]

```ts
const models = ctx.modelRegistry.getAll(); // 已知聊天模型，不只已认证的
const current = ctx.modelRegistry.find(providerId, modelId);
const authenticated = ctx.modelRegistry.getAvailable(); // 认证可用快照
```

`getAll()` 更适合配置编辑器；只用 `getAvailable()` 会隐藏尚未配置认证、恰恰需要添加的模型。registry 包含用户配置/扩展/宿主已加载的目录结果，不是纯官方基线；缓存刷新状态也会影响新鲜度。需要“官方原值 vs 本地覆盖”的比较时，不能拿 registry 自己与自己比较。

Pi 的 [模型文档][models-doc]提供 `pi update --models` 强制刷新。插件不应在每次键入/选择时触发全量刷新。本次只核对 SDK/源码，不声称已经验证插件 TUI 的这条接入路径。

纯离线官方模板也可从 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModels(provider)` / `getBuiltinModel(provider, id)` 取得；它是对应 npm 包的 bundled 数据，不是远端最新数据。现有项目安装的 1.4.0 与本机宿主 1.5.0 是两个不同基线；不能用项目包的静态模板冒充宿主实际值。

### B. 直接请求官方 Provider shard：用于纯官方参考、独立目录浏览

例如：

```text
GET https://pi.dev/api/models/providers/deepseek?pi-version=1.4.0
Accept: application/json
```

200 时校验对象结构，使用 `Object.values(body)` 得到聊天条目；已有匹配缓存时才加 `If-None-Match`，304 复用缓存。以结构化元数据保留 `source/provider/type/id/revision/fetchedAt`，不把这些溯源信息塞进原生 model 配置。

这不是端点自身的 `/models`：它列出官方目录模型，不能证明用户账号/网关/代理实际可以调用。应保留两种入口的差别。

## 5. 本仓落点与候选交互

现状已核验：

- `model-editor.ts:556–565`：手动新建模型固定填入 `reasoning:false`、`input:["text"]`、128K context、16K output、全零 cost；不是针对该模型的元数据。
- `model-editor.ts:854–879`：输入 ID 后立即用上述模板写入，再打开编辑器。
- `endpoint-models.ts` 的 `normalizeEndpointModels()`：只接受数组/`data[]`/`models[]`，输出仅保留 `id/name`。实测直接输入官方 legacy Provider shard 得到 `supported:false`；typed shard 虽能读取，也会丢掉能力、价格和限制。
- `provider-editor.ts:278–340`：端点拉取已有合并/替换、预览、确认及 stale-target 重新确认路径。接入新数据不应绕过这些写回保护。

候选方向（本次未实现）：

1. **模型选择/新建参考卡**：按 Provider、ID、名称搜索，展示图像输入/推理徽标、上下文、输出限制、基础价及分档提示。先选参考模型并预览草稿，再提交，减少固定模板导致的后续手工补填。
2. **编辑器旁边显示参考值与来源**：本地显式值、catalog 参考值、缺省/继承分开；允许用户逐项采用，不是每次打开就覆盖。
3. **端点发现后可选补全**：端点列表决定候选 ID，官方目录只提供元数据建议。同 Provider/type/精确 ID 可给出对应参考；代理别名或跨 Provider 匹配需用户明确选择，不做模糊自动写回。
4. **官方刷新是显式动作**：来源与新鲜度可见，离线仍可编辑；已有值变化先给差异预览。

写回边界：

- 内置模型的定制优先通过最小 `modelOverrides` 保持继承；不要为展示方便完整拷贝成固定 `models` 条目。
- 自定义代理保留现有 Provider/model ID、`baseUrl`、`api`、认证和 header。跨 Provider 的价格、compat、cache、图片限制等均需按实际端点复核。
- chat 编辑器不得因为 typed API 返回了 image/classifier 就把它们当聊天模型导入。
- “端点返回了这个 ID”“官方卡片有该字段”“当前端点已验证支持”是三个不同结论。

## 6. 证据与验证边界

- [可复跑探针](research/pi-dev-model-cards/probe.mjs)：`node --experimental-strip-types docs/research/pi-dev-model-cards/probe.mjs`。只访问公开 catalog、调用本仓 normalization 函数、更新同目录 `evidence.json`；不调用模型或写用户配置。
- [HTTP/形态/字段覆盖率/样本证据](research/pi-dev-model-cards/evidence.json)：含请求时间、URL、响应头、状态、计数；并非全部约 1 MB 原始目录存档。
- [浏览器卡片证据](research/pi-dev-model-cards/card-evidence.json)：配置示例、价格和有效 compat 表、相关模型链接。
- 未实测扩展加载后的 UI、各种代理的真实协议/价格、所有模型字段的有效性；没有修改测试依赖，不宣称完成新 Pi 版本适配。
- 独立 reviewer 未完成：首次连接失败，一次限时恢复超时，均未产出结论。按用户指示停止后续 reviewer；本文结论来自主会话的源码核对和实测，不标为独立复核通过。

[catalog-readme]: https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/ai/catalog/README.md
[deepseek-source]: https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/ai/catalog/providers/deepseek.ts
[protocol]: https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/scripts/model-catalog-protocol.ts
[remote-client]: https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/coding-agent/src/core/remote-catalog-provider.ts
[publish-workflow]: https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/.github/workflows/publish-model-catalog.yml
[registry]: https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/coding-agent/src/core/model-registry.ts
[models-doc]: https://pi.dev/docs/latest/models

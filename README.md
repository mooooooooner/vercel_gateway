# Vercel Gateway Manager

统一管理多个 **Vercel AI Gateway** 订阅 Key 的网关，同时是一个 **OpenAI 兼容**的代理服务，对多个 Key 做负载均衡与故障转移。

## 功能

- ✅ **批量添加 Key**：粘贴文本（换行 / 逗号 / 空格分隔），自动去重
- ✅ **删除 Key**：单个删除、勾选批量删除
- ✅ **自定义并发查询额度**：可设置并发数，批量刷新每个 Key 的余额
- ✅ **一键清理额度不足**：先刷新再自动删除「余额不足 / 失效」的 Key
- ✅ **激活选中 Key**：对勾选的 Key 调用 `zai/glm-5.2` 发送极短测试消息，触发上游激活
- ✅ **默认参数自定义**：以 JSON 配置注入 chat/completions 默认参数（可留空）
- ✅ **优雅前端**：Anthropic 官网风格（暖米色 + 陶土红 + 衬线标题）
- ✅ **负载均衡**：轮询 / 最少使用 / 余额优先 / 低额度优先 / 随机，失败自动切换下一个 Key
- ✅ **Debug 模式 + 实时日志**：前端「运行日志」选项卡通过 SSE 实时查看每次代理的 key 选择、上游状态、重试与异常；Debug 可在页面随时开关
- ✅ **图片生成**：管理后台「图片生成」选项卡，默认 `bytedance/seedream-5.0-pro`；可上传参考图走 `/v1/images/edits`，结果落盘到服务器并可回看历史
- ✅ **代理 Key 管理**：后台「代理 Key」选项卡在线增删 / 启停客户端调用 `/v1` 用的 Key（支持随机生成、完整 Key 复制）；按 Key 统计聊天接口的消耗（tokens + 上游返回的美元 cost）与缓存命中率（`cached_tokens / prompt_tokens`），统计持久化到 `data/proxy-keys.json`

## 快速开始

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# 编辑 .env，至少设置 ADMIN_TOKEN 和 PROXY_API_KEYS
npm start
```

打开 http://localhost:8787 进入管理后台。

> 需要 Node.js ≥ 18.17（使用内置 `fetch`）。

## 环境变量（.env）

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `8787` |
| `ADMIN_TOKEN` | 管理后台 / `/api` 接口令牌。留空则无鉴权 |
| `PROXY_API_KEYS` | 客户端调用 `/v1` 所需的 Key，逗号分隔多个。**启动时会自动迁移进 `data/proxy-keys.json`**，之后在后台「代理 Key」页管理即可，改 `.env` 不再需要重启。留空且后台也无 Key 则不校验 |
| `GATEWAY_BASE_URL` | 上游地址，默认 `https://ai-gateway.vercel.sh/v1` |
| `GATEWAY_CREDITS_URL` | 额度查询地址，默认 `https://ai-gateway.vercel.sh/v1/credits` |
| `LOW_BALANCE_THRESHOLD` | 判定额度不足的阈值（美元），默认 `0.01` |
| `DEBUG` | Debug 模式（`1/true/on`）。记录每次代理的详细过程，可在前端随时开关 |

## 作为 OpenAI 代理使用

把任意 OpenAI SDK 的 `base_url` 指向本服务的 `/v1`，`api_key` 用 `PROXY_API_KEYS` 里配置的值：

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="sk-your-proxy-key")
resp = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

网关会自动从可用的 Vercel Key 池中挑选一个转发；某个 Key 失败（401/402/429/5xx）会自动切换到下一个。支持 `stream: true` 流式透传。

### 支持的端点

- `POST /v1/chat/completions`（负载均衡 + 注入默认参数 + 流式）
- `POST /v1/completions`
- `POST /v1/embeddings`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `GET  /v1/models`

## 管理 API（需 `x-admin-token` 或 `Authorization: Bearer <ADMIN_TOKEN>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats` | 概览统计 |
| GET/PUT | `/api/settings` | 负载策略与默认参数 |
| GET | `/api/keys` | Key 列表（脱敏） |
| POST | `/api/keys` | 批量添加 `{ text, namePrefix? }` |
| POST | `/api/keys/delete` | 批量删除 `{ ids }` |
| DELETE | `/api/keys/:id` | 删除单个 |
| PATCH | `/api/keys/:id` | 启用/停用/改名 |
| POST | `/api/keys/refresh` | 刷新额度 `{ concurrency, ids? }` |
| POST | `/api/keys/activate` | 激活选中 Key：对每个 key 用 `zai/glm-5.2` 发测试消息 `{ ids, concurrency? }` |
| POST | `/api/keys/prune` | 清理额度不足 `{ threshold?, concurrency? }` |
| GET | `/api/proxy-keys` | 代理 Key 列表（脱敏）+ 每个 Key 的用量统计与缓存命中率 |
| POST | `/api/proxy-keys` | 批量添加 `{ text?, namePrefix?, generate? }`，`generate: n` 随机生成 n 个 |
| POST | `/api/proxy-keys/delete` | 批量删除 `{ ids }` |
| DELETE | `/api/proxy-keys/:id` | 删除单个 |
| PATCH | `/api/proxy-keys/:id` | 启用/停用/改名 |
| POST | `/api/proxy-keys/reset-stats` | 用量统计清零 `{ ids? }`（留空清零全部） |
| GET | `/api/proxy-keys/:id/reveal` | 查看完整 Key（用于复制给客户端） |
| GET | `/api/logs` | 拉取最近日志 |
| GET | `/api/logs/stream` | 实时日志（SSE，令牌用 `?token=` 传递） |
| GET/PUT | `/api/debug` | 查询 / 开关 Debug 模式 `{ debug }` |
| POST | `/api/images/generate` | 生成图片并保存 `{ prompt, model?, size?, n?, references? }`；有参考图时走 `/images/edits` |
| GET | `/api/images` | 生成历史列表 |
| GET | `/api/images/:id/file` | 读取已保存图片 `?index=` |
| DELETE | `/api/images/:id` | 删除一条历史及其文件 |

## 数据存储

Key、代理 Key（含用量统计）、设置与图片生成历史以 JSON 明文保存在 `data/`（图片文件在 `data/images/`，已在 `.gitignore` 中）。请妥善保管服务器与 `data/` 目录访问权限。

可用 `DATA_DIR` 环境变量把数据目录指到别处。

## 用量统计说明

- 统计范围：仅聊天接口 `POST /v1/chat/completions`、`/v1/completions`、`/v1/messages`、`/v1/responses`；图片与 embeddings 不计入。
- 数据来源：上游响应的 `usage` 字段。非流式直接解析 JSON；流式请求会在客户端未指定时注入 `stream_options.include_usage` 并旁路嗅探 SSE 尾块，兼容 OpenAI / Anthropic 字段命名。
- 缓存命中率 = `cached_tokens / prompt_tokens`（取 `prompt_tokens_details.cached_tokens` 或 `cache_read_input_tokens`）。
- 消耗 (USD) 取上游返回的 `usage.cost` 等字段，上游未返回时该列显示 `—`，tokens 统计不受影响。

## 说明

上游地址与额度接口做成了可配置项。若 Vercel 调整了路径或额度返回字段，改 `.env` 中的 `GATEWAY_BASE_URL` / `GATEWAY_CREDITS_URL` 即可，无需改代码。额度查询兼容 `balance` / `total_used` 等常见字段命名。

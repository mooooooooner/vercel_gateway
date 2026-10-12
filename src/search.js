// Vercel AI Gateway 内置搜索工具（server tools）封装。
// 文档: https://vercel.com/docs/ai-gateway/models-and-providers/web-search
// 在 Chat Completions 里通过 tools: [{ type: 'vercel:<provider>_search', config: {...} }] 调用，
// 上游执行搜索并把结果注入模型上下文，最终返回基于搜索结果的回答（结果不透出原始链接列表）。
import { store } from './store.js';

// 各搜索供应商定义。queryField 为该工具必填的 config 字段（parallel 为 objective）。
export const SEARCH_PROVIDERS = {
  perplexity: {
    toolType: 'vercel:perplexity_search',
    queryField: 'query',
    label: 'Perplexity Search',
    configKeys: ['max_results', 'max_tokens', 'max_tokens_per_page', 'country', 'search_language_filter', 'search_domain_filter', 'search_recency_filter'],
  },
  exa: {
    toolType: 'vercel:exa_search',
    queryField: 'query',
    label: 'Exa Search',
    configKeys: ['type', 'num_results', 'category', 'user_location', 'include_domains', 'exclude_domains', 'start_published_date', 'end_published_date', 'contents'],
  },
  tako: {
    toolType: 'vercel:tako_search',
    queryField: 'query',
    label: 'Tako Search',
    configKeys: ['effort', 'sources', 'include_related', 'location', 'country_code', 'locale', 'timezone'],
  },
  browserbase: {
    toolType: 'vercel:browserbase_search',
    queryField: 'query',
    label: 'Browserbase Search',
    configKeys: ['num_results'],
  },
  parallel: {
    toolType: 'vercel:parallel_search',
    queryField: 'objective',
    label: 'Parallel Search',
    configKeys: ['mode', 'max_results', 'search_queries', 'source_policy', 'excerpts', 'fetch_policy'],
  },
};

// 读取搜索默认配置（带兜底与裁剪）。
export function getSearchSettings() {
  const s = store.getSettings().search || {};
  const provider = SEARCH_PROVIDERS[s.provider] ? s.provider : 'perplexity';
  const maxResults = Number(s.maxResults);
  return {
    model: typeof s.model === 'string' && s.model.trim() ? s.model.trim() : 'zai/glm-5.2',
    provider,
    maxResults: Number.isFinite(maxResults) && maxResults >= 1 ? Math.min(20, Math.floor(maxResults)) : 10,
  };
}

// model 是否为搜索别名（perplexity/search、exa/search…，或裸 "search"）。返回供应商名或 null。
export function resolveSearchAlias(model) {
  if (!model || typeof model !== 'string') return null;
  const id = model.trim().toLowerCase();
  if (!id) return null;
  if (id === 'search') return getSearchSettings().provider;
  const [name, suffix] = id.split('/');
  if (suffix === 'search' && SEARCH_PROVIDERS[name]) return name;
  return null;
}

// 从 messages 里提取最后一条用户消息文本，作为搜索 query。
export function extractQuery(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n').trim();
    }
    return '';
  }
  return '';
}

// 组装搜索工具的 config：通用便捷字段按供应商映射 + 显式 config 覆盖（config 优先）。
function buildConfig(providerName, opts = {}) {
  const provider = SEARCH_PROVIDERS[providerName];
  const config = { [provider.queryField]: opts.query };
  if (opts.maxResults != null) {
    if (providerName === 'exa' || providerName === 'browserbase') config.num_results = opts.maxResults;
    else config.max_results = opts.maxResults;
  }
  if (Array.isArray(opts.domainFilter) && opts.domainFilter.length) {
    if (providerName === 'perplexity') config.search_domain_filter = opts.domainFilter;
    else if (providerName === 'exa') config.include_domains = opts.domainFilter;
  }
  if (providerName === 'perplexity') {
    if (opts.recencyFilter) config.search_recency_filter = opts.recencyFilter;
    if (Array.isArray(opts.languageFilter) && opts.languageFilter.length) config.search_language_filter = opts.languageFilter;
    if (opts.country) config.country = opts.country;
  } else if (providerName === 'tako' && opts.country) {
    config.country_code = opts.country;
  }
  // 仅保留该供应商声明支持的键，避免把无关字段塞给上游
  const explicit = (opts.config && typeof opts.config === 'object' && !Array.isArray(opts.config)) ? opts.config : {};
  for (const [key, value] of Object.entries(explicit)) {
    if (provider.configKeys.includes(key) || key === provider.queryField) config[key] = value;
  }
  return config;
}

/**
 * 把 model 为搜索别名（如 perplexity/search）的 chat/completions 请求体
 * 改写为「真实对话模型 + 搜索 server tool」。
 * 客户端已自带 vercel:* 工具时只替换 model，不重复注入。
 * 返回 { body, provider, query }；query 无法提取时返回 { error }。
 */
export function rewriteSearchAliasBody(clientBody) {
  const providerName = resolveSearchAlias(clientBody?.model);
  if (!providerName) return null;
  const settings = getSearchSettings();
  const query = extractQuery(clientBody.messages);
  if (!query) {
    return { error: `搜索模型「${clientBody.model}」需要 messages 中至少有一条包含文本的用户消息` };
  }
  const body = { ...clientBody, model: settings.model };
  const hasServerTool = Array.isArray(body.tools)
    && body.tools.some((t) => typeof t?.type === 'string' && t.type.startsWith('vercel:'));
  if (!hasServerTool) {
    const config = buildConfig(providerName, { query, maxResults: settings.maxResults });
    body.tools = [...(Array.isArray(body.tools) ? body.tools : []), { type: SEARCH_PROVIDERS[providerName].toolType, config }];
    if (!body.tool_choice) body.tool_choice = 'required';
  }
  return { body, provider: providerName, query };
}

/**
 * /v1/search 请求体 → chat/completions 请求体。
 * 输入：{ query, provider?, model?, instructions?, max_results?, recency_filter?,
 *        domain_filter?, language_filter?, country?, config?, stream?, max_tokens?, temperature? }
 * 返回 { body, provider, query, model } 或 { error }。
 */
export function buildSearchRequestBody(input = {}) {
  const settings = getSearchSettings();
  const providerName = SEARCH_PROVIDERS[input.provider] ? input.provider : settings.provider;
  const query = String(input.query ?? '').trim();
  if (!query) return { error: '缺少 query 字段（要搜索的内容）' };
  const model = String(input.model ?? '').trim() || settings.model;

  const messages = [];
  if (input.instructions) messages.push({ role: 'system', content: String(input.instructions) });
  messages.push({ role: 'user', content: query });

  const config = buildConfig(providerName, {
    query,
    maxResults: input.max_results ?? input.maxResults ?? settings.maxResults,
    recencyFilter: input.recency_filter,
    domainFilter: input.domain_filter,
    languageFilter: input.language_filter,
    country: input.country,
    config: input.config,
  });

  const body = {
    model,
    messages,
    tools: [{ type: SEARCH_PROVIDERS[providerName].toolType, config }],
    tool_choice: input.tool_choice || 'required',
    stream: input.stream === true,
  };
  for (const key of ['max_tokens', 'temperature', 'top_p']) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return { body, provider: providerName, query, model };
}

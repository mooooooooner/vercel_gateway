// 从上游响应中提取 usage 统计（tokens / cost / 缓存命中）。
// 兼容 OpenAI chat/completions、Responses、Anthropic messages 等字段命名。

function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 从 JSON 响应体提取 usage。
 * @returns {{ promptTokens:number, completionTokens:number, cachedTokens:number, cost:number } | null}
 */
export function extractUsage(data) {
  const u = data?.usage || data?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  const prompt = num(u.prompt_tokens ?? u.input_tokens);
  const completion = num(u.completion_tokens ?? u.output_tokens);
  const cached = num(
    u.prompt_tokens_details?.cached_tokens
      ?? u.input_tokens_details?.cached_tokens
      ?? u.cache_read_input_tokens
      ?? u.cached_tokens
  );
  const cost = num(u.cost ?? u.total_cost ?? u.gateway_cost ?? u.cost_usd);
  if (prompt === null && completion === null && cached === null && cost === null) return null;
  return {
    promptTokens: prompt || 0,
    completionTokens: completion || 0,
    cachedTokens: cached || 0,
    cost: cost || 0,
  };
}

// SSE 流式响应中可能出现 usage 的字段（Anthropic 的输入用量在开头的 message_start，
// OpenAI 的完整 usage 在最后一个 chunk，故逐字段取最大值即为最终值）。
const NUM_FIELDS = [
  ['promptTokens', /(?<!\\)"(?:prompt_tokens|input_tokens)"\s*:\s*("?)(\d+(?:\.\d+)?)\1/g],
  ['completionTokens', /(?<!\\)"(?:completion_tokens|output_tokens)"\s*:\s*("?)(\d+(?:\.\d+)?)\1/g],
  ['cachedTokens', /(?<!\\)"(?:cached_tokens|cache_read_input_tokens)"\s*:\s*("?)(\d+(?:\.\d+)?)\1/g],
  ['cost', /(?<!\\)"(?:cost|total_cost|gateway_cost|cost_usd)"\s*:\s*("?)\$?(\d+(?:\.\d+)?)\1/g],
];

/**
 * 流式透传时的旁路嗅探器：把每个 SSE chunk 喂给 push()，
 * 结束后 result() 返回提取到的 usage（未发现任何字段则返回 null）。
 * 每块仅保留少量尾部 overlap 处理跨块截断，内存占用 O(1)。
 */
export function createSseUsageScanner() {
  const max = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  let found = false;
  let overlap = '';

  return {
    push(text) {
      const buf = overlap + text;
      overlap = buf.length > 2048 ? buf.slice(-2048) : buf;
      for (const [field, re] of NUM_FIELDS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(buf))) {
          const v = Number(m[2]);
          if (Number.isFinite(v) && v > max[field]) {
            max[field] = v;
            found = true;
          }
        }
      }
    },
    result() {
      if (!found) return null;
      return { ...max };
    },
  };
}

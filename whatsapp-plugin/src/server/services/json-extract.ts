/**
 * 从模型输出里抠出 JSON 对象。三个模型都不能假设：
 *
 * 1. 可能包在 ```json 围栏里（CLI 尤其常见）；
 * 2. 可能在 JSON 前后夹了寒暄（CLI 是个 Agent，不是补全接口，"Sure, here you go:" 是常态）；
 * 3. 可能整段都不是 JSON。
 *
 * ⚠️ 不能用「第一个 `{` 到最后一个 `}`」这种偷懒写法：正文里若出现花括号（例如回复客户时写了
 * `{价格}` 占位符），截出来的就是坏 JSON。这里用括号计数并**跳过字符串内**的括号。
 *
 * 抽成独立模块的原因：资源推荐的 AI 复排与自动回复出稿是两条链路，
 * 但"怎么从 CLI 输出里拿 JSON"必须只有一套口径 —— 两处各写一份，早晚会在围栏/转义上分叉。
 */
export function extractJsonObject(content: string): string {
  const trimmed = String(content ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  if (start === -1) return candidate;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, index + 1);
    }
  }
  return candidate.slice(start);
}

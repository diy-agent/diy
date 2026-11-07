/**
 * services/remote-discover-options.ts —— 发现源的「字符串或数组」规整
 *
 * 2026-11-06 从 api-impl.ts 提出来：remote 域搬走后 impl 也要用。
 */

export function splitListOption(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = Array.isArray(value) ? value : value.split(",");
  const out = parts
    .map((v) => v.trim().replace(/^\[|\]$/g, "").replace(/^"|"$/g, ""))
    .filter((v) => v !== "");
  return out.length > 0 ? out : undefined;
}

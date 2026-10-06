// scripts/probe-cache-ttl.mts — 缓存 TTL 实探（**手工跑，不进自动测试**）
//
// 为什么要手工：它**真花钱**（真模型、真请求），而自动测试必须离线可重复
// （用户 2026-10-06：「llm 真实测试不要进入自动测试代码，手工脚本单独探测即可，
//  自动测试里用 mock 或 stub 隔离」）。共享侧的**夹逼/判定**逻辑是纯函数，
// 已在 tests/core/cache-ttl.test.ts 里用构造数据覆盖 —— 本脚本只负责「造真观测」。
//
// 用法（需真 key；只在 worktree 隔离 home 里跑，别碰 ~/.diy）：
//   DIY_HOME=$PWD/build/home OPENCODE_ZEN_API_KEY=... \
//     npx tsx scripts/probe-cache-ttl.mts --model mimo-v2.6-flash --gaps 1,20,40,55,70
//
// 做法（对照 ##230#439 的"只发头部"结论 —— 探针越长越贵，但太短可能低于缓存门槛）：
//   1. 用一段**固定前缀**（--probe-tokens 近似长度）发第 1 次请求 → 建立缓存
//   2. 等 gap 分钟
//   3. 发**同一条**请求 → 读 usage.cacheReadTokens
//        命中（>0） → ttl > gap      （下界候选）
//        未命（=0） → ttl ≤ gap      （上界候选）
//   每次只花「探针长度」的钱（不是整个上下文）—— 这正是探针的价值。
//
// ⚠️ 三项必须自行观察的事（##230#439 遗留）：
//   · 头部缓存命中能否代表整体命中（缓存按块，通常 64/128 token 粒度）
//   · 探针是否刷新 TTL（刷新 = 能免费保活；不刷新 = 一次只能测一个 gap）
//   · 最小可探测长度（太短可能永远测不准）

const args = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
};

const model = arg("model", "mimo-v2.6-flash")!;
const gapsMin = (arg("gaps", "1,20,40,55,70") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const probeTokens = Number(arg("probe-tokens", "2000"));
const baseUrl = arg("base-url", "https://opencode.ai/zen/v1")!;

const key = process.env["OPENCODE_ZEN_API_KEY"] ?? "";
if (!key) {
    console.error("缺 OPENCODE_ZEN_API_KEY（本脚本打真上游）");
    process.exit(2);
}

/** 固定前缀：用可复现的确定性文本（重复词块）凑近似长度；同一段必须**逐字复用**，否则前缀不同 */
function prefix(): string {
    const unit = "The quick brown fox jumps over the lazy dog. 缓存前缀探针。";
    const perUnit = unit.length; // 混合中英，近似 token 数按 3 字符/token 粗估
    const n = Math.max(1, Math.ceil((probeTokens * 3) / perUnit));
    return unit.repeat(n);
}

async function once(messages: Array<{ role: string; content: string }>) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, max_tokens: 1, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
    return {
        prompt: j.usage?.prompt_tokens ?? 0,
        cached: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
}

const P = prefix();
console.log(`模型 ${model} · 探针 ${probeTokens} tok（近似 ${P.length} 字符）· gaps(min) = ${gapsMin.join(", ")}`);

// 建立缓存
const warm = await once([{ role: "user", content: P }]);
console.log(`[warm] prompt=${warm.prompt} cached=${warm.cached}  ← 首次必然 0（建立缓存）`);

let last = Date.now();
for (const g of gapsMin) {
    const waitMs = Math.max(0, last + g * 60_000 - Date.now());
    if (waitMs > 0) {
        console.log(`  … 等 ${(waitMs / 60000).toFixed(1)} 分钟`);
        await new Promise((r) => setTimeout(r, waitMs));
    }
    const r = await once([{ role: "user", content: P }]);
    const hit = r.cached > 0;
    console.log(
        `[gap=${String(g).padStart(3)}min] prompt=${r.prompt} cached=${r.cached} → ` +
            (hit ? `命中 ⇒ ttl > ${g}min` : `未命中 ⇒ ttl ≤ ${g}min`),
    );
    last = Date.now();
}

console.log("\n把上面的「命中/未命中 + gap」写成 CacheObservation[]（同一前缀 ⇒ samePrefix=true），");
console.log("喂 ttlBoundsFrom() 即得区间 (aliveUpTo, deadFrom] —— 见 src/shared/context/cache-ttl.ts。");
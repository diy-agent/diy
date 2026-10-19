// scripts/probe-reasoning-400.mts
// 🎯 复现探针（##371）：thinking 模式下「assistant 带 tool_calls 却缺 reasoning_content」何时 400
//
// 用法：OPENCODE_ZEN_API_KEY=... npx tsx scripts/probe-reasoning-400.mts [--rounds 6] [--concurrency 12]
// 可选：PROBE_BASE_URL（缺省生产同款 https://opencode.ai/inference/go/openai/v1）
//
// 结论（2026-10-17 实测）：
//   · 上游按端点分流到多个后端，**它们的行为不一致**：
//       - luminal-dsv4.1flash  —— 严格要求回传 reasoning_content，缺了必 400
//         （`The reasoning_content in the thinking mode must be passed back to the API`）
//       - orcarouter / deepinfra / manhattan 等 —— 不校验，缺了也 200
//   · 所以「同一请求体，有时 400 有时 200」不是抖动，而是**命中了哪个后端**。
//   · 命中 luminal 的比例不高（实测 ~1/48 ~ 9/72），故用并发 + 多轮去撞它。
//   · 带 reasoning_content 的同一请求在 luminal 上 100% 200 ⇒ 修法（回传推理）是对策。
//
// 修复落点见 src/main/services/local-blocks.ts::projectAll（think 块 → assistant 的 reasoning part）。

const key = process.env["OPENCODE_ZEN_API_KEY"];
if (!key) throw new Error("缺少 OPENCODE_ZEN_API_KEY（本脚本打真上游）");
const BASE = process.env["PROBE_BASE_URL"] ?? "https://opencode.ai/inference/go/openai/v1";
const arg = (name: string, dflt: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const ROUNDS = arg("rounds", 6);
const CONCURRENCY = arg("concurrency", 12);

const tools = [
    {
        type: "function",
        function: {
            name: "bash",
            description: "在项目目录执行 bash 命令并返回输出。",
            parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
            },
        },
    },
];

/** 生产 400 的形状：历史末尾 = assistant(tool_calls) + tool —— 工具结果回填后马上要下一步 */
function history(withReasoning: boolean) {
    const assistant: Record<string, unknown> = {
        role: "assistant",
        content: null,
        tool_calls: [
            {
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "echo probe-371" }) },
            },
        ],
    };
    if (withReasoning) assistant["reasoning_content"] = "用户要跑 echo probe-371，我调用 bash 工具。";
    return [
        { role: "user", content: "请用 bash 执行 echo probe-371 并汇报（一句话）" },
        assistant,
        { role: "tool", tool_call_id: "call_1", content: "probe-371" },
    ];
}

async function send(withReasoning: boolean, session: string): Promise<{ endpoint: string; status: number }> {
    const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "x-opencode-session": session,
        },
        body: JSON.stringify({
            model: "deepseek-v4.1-flash", // 思考档受害者（允许清单内）
            max_tokens: 100,
            stream: false,
            messages: history(withReasoning),
            tools,
            reasoning_effort: "high",
        }),
    });
    return { endpoint: res.headers.get("x-opencode-endpoint-id") ?? "(none)", status: res.status };
}

async function runGroup(label: string, withReasoning: boolean) {
    const stat = new Map<string, number>();
    for (let round = 0; round < ROUNDS; round++) {
        const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                // session 头必须是 ascii（中文会让 fetch 报 ByteString 错）
send(withReasoning, `probe-371-${withReasoning ? "with" : "without"}-${round}-${i}`).catch((e) => ({
                    endpoint: `error:${String((e as Error)?.message ?? e).slice(0, 80)}`,
                    status: 0,
                })),
            ),
        );
        for (const r of results) {
            const k = `${r.endpoint} → HTTP ${r.status}`;
            stat.set(k, (stat.get(k) ?? 0) + 1);
        }
    }
    console.log(`\n【${label}】`);
    for (const [k, v] of [...stat].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
}

console.log(`复现探针：${ROUNDS} 轮 × ${CONCURRENCY} 并发，baseURL=${BASE}`);
await runGroup("缺 reasoning_content", false);
await runGroup("带 reasoning_content", true);
console.log("\n期望：缺 rc 组在 luminal 上出现 400；带 rc 组在 luminal 上全 200。");

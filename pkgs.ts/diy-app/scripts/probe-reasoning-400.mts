// scripts/probe-reasoning-400.mts
// 🎯 复现探针（##371 建 · ##374 T1 扩）：thinking 模式下「assistant 带 tool_calls 却缺 reasoning_content」何时 400
//
// 用法：OPENCODE_ZEN_API_KEY=... npx tsx scripts/probe-reasoning-400.mts [--rounds 6] [--concurrency 12]
// 可选：PROBE_BASE_URL（缺省生产同款 https://opencode.ai/inference/go/openai/v1）
//
// 结论（2026-10-17 实测，单轮形状）：
//   · 上游按端点分流到多个后端，**它们的行为不一致**：
//       - luminal-dsv4.1flash  —— 严格要求回传 reasoning_content，缺了必 400
//         （`The reasoning_content in the thinking mode must be passed back to the API`）
//       - orcarouter / deepinfra / manhattan 等 —— 不校验，缺了也 200
//   · 所以「同一请求体，有时 400 有时 200」不是抖动，而是**命中了哪个后端**。
//   · 命中 luminal 的比例不高，故用并发 + 多轮去撞它。
//
// ##374 T1 的**新问题**（同一端点内）：校验是「逐条」还是「只看末尾」？
//   · 组 A `深缺/末有`：第 1 条 assistant(tool_calls) 缺 rc、第 2 条（末尾）带 rc
//       ⇒ luminal 400 ⇒ **逐条校验**（「只回传最近 K 步」方案作废）
//       ⇒ luminal 200 ⇒ 只校验末尾那条（可只回传最近 K 步，结论写任务 body）
//   · 组 B `全带`（对照，期望 luminal 全 200）
//   · 组 C `末缺`（正对照，期望 luminal 400 —— 即原 ##371 的形状）
//
// 测法要点：**必须按端点分组统计**。跨端点一锅烩的数没有意义（校验与否按端点分流）。

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

/** 两轮工具调用的历史：第 1 次 assistant 在深历史、第 2 次 assistant 在末尾（各带 / 不带 rc 可调） */
function history(opts: { first: boolean; last: boolean }) {
    const assistant = (callId: string, cmd: string, withReasoning: boolean): Record<string, unknown> => {
        const m: Record<string, unknown> = {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } },
            ],
        };
        if (withReasoning) m["reasoning_content"] = `用户要跑 ${cmd}，我调用 bash 工具。`;
        return m;
    };
    return [
        { role: "user", content: "请依次用 bash 执行 echo probe-374-a 与 echo probe-374-b（各一句话汇报）" },
        assistant("call_a", "echo probe-374-a", opts.first),
        { role: "tool", tool_call_id: "call_a", content: "probe-374-a" },
        assistant("call_b", "echo probe-374-b", opts.last),
        { role: "tool", tool_call_id: "call_b", content: "probe-374-b" },
    ];
}

interface Result {
    endpoint: string;
    status: number;
    body?: string;
}

async function send(opts: { first: boolean; last: boolean }, session: string): Promise<Result> {
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
            messages: history(opts),
            tools,
            reasoning_effort: "high",
        }),
    });
    const endpoint = res.headers.get("x-opencode-endpoint-id") ?? "(none)";
    if (res.status >= 400) {
        const text = await res.text().catch(() => "");
        return { endpoint, status: res.status, body: text.slice(0, 300) };
    }
    return { endpoint, status: res.status };
}

async function runGroup(label: string, opts: { first: boolean; last: boolean }) {
    const stat = new Map<string, number>();
    const errSamples = new Map<string, string>();
    for (let round = 0; round < ROUNDS; round++) {
        const tag = `probe-374-${label.replace(/[^a-z0-9]/gi, "")}-${round}`;
        const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                // session 头必须是 ascii（中文会让 fetch 报 ByteString 错）
                send(opts, `${tag}-${i}`).catch(
                    (e): Result => ({
                        endpoint: `error:${String((e as Error)?.message ?? e).slice(0, 80)}`,
                        status: 0,
                    }),
                ),
            ),
        );
        for (const r of results) {
            const k = `${r.endpoint} → HTTP ${r.status}`;
            stat.set(k, (stat.get(k) ?? 0) + 1);
            if (r.status >= 400 && r.body && !errSamples.has(k)) errSamples.set(k, r.body);
        }
    }
    console.log(`\n【${label}】first.rc=${opts.first} last.rc=${opts.last}`);
    for (const [k, v] of [...stat].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${v}`);
        const sample = errSamples.get(k);
        if (sample) console.log(`      ↳ ${sample.replace(/\s+/g, " ")}`);
    }
    return stat;
}

console.log(`复现探针（##374 T1）：${ROUNDS} 轮 × ${CONCURRENCY} 并发，baseURL=${BASE}`);
// 组 C 是原 ##371 的形状（末条缺 rc）—— 正对照：luminal 必 400，证明「这一轮确实撞上了校验型端点」
await runGroup("C-末缺（正对照）", { first: true, last: false });
await runGroup("A-深缺末有", { first: false, last: true });
await runGroup("B-全带（对照）", { first: true, last: true });
console.log(
    "\n读法：只看 luminal-dsv4.1flash 行。C 组 400 而 B 组全 200 ⇒ 探针有效；" +
        "此时 A 组 400 ⇒ 逐条校验（只回传最近 K 步作废）；A 组 200 ⇒ 只校验末尾。",
);

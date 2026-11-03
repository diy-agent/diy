// components/TaskFactsView.tsx — 任务级事实库的**只读视图**（##404 演示）
//
// 两个视图：**原 YAML**（真源，不解析不校验）/ **投影**（给 LLM 看的那份，变体已解析）。
// 为什么这里不能编辑：事实的写入**只走 `diy facts submit`** —— 整批事务 + 六条机械判据
// （G1–G5 + W1）。UI 上能改就一定会有人改，而手改 YAML 正是这套东西要消灭的错法。
//
// 为什么原 YAML 不复用 `facts.status` 的结果再 dump：那样看到的是"解析后再写回"的形态
// （顺序、注释、空行全变），而这一栏的用处恰恰是**看真源长什么样**。
import { For, Show, createResource, createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { CodeBlock } from "./CodeBlock";

type Algo = "yaml-nested" | "flat-gid" | "md-list";

const ALGOS: { id: Algo; label: string }[] = [
    { id: "yaml-nested", label: "yaml-nested（按 ns 分组 · 缺省）" },
    { id: "flat-gid", label: "flat-gid（一行一条 gid）" },
    { id: "md-list", label: "md-list（markdown 列表）" },
];

type Res<T> = { ok: true; data: T } | { ok: false; err: string };

async function guard<T>(p: Promise<T>): Promise<Res<T>> {
    try {
        return { ok: true, data: await p };
    } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
}

export function TaskFactsView(props: { uri: string }) {
    /** 任务级库的定位串（**显式给 uri**，不做"当前任务"推导 —— 同时干两个任务时无从判断） */
    const spec = () => `task:${props.uri}`;
    // 默认给**投影**（那就是 LLM 真看到的东西）；要看真源按 `<>`。
    const [mode, setMode] = createSignal<"raw" | "projection">("projection");
    const [algo, setAlgo] = createSignal<Algo>("yaml-nested");

    // 客户端 input 的可选字段在类型上是「必给的 undefined」（见 TrafficLogCleanup 的同类写法），
    // 故这里把没用到的键显式写成 undefined，而不是靠断言绕过类型。
    const [raw, { refetch: refetchRaw }] = createResource(spec, (s) =>
        guard(diyService.diy.facts.raw({ in: s, dir: undefined })),
    );
    const [proj, { refetch: refetchProj }] = createResource(
        () => (mode() === "projection" ? { in: spec(), algorithm: algo() } : null),
        (q) =>
            guard(
                diyService.diy.facts.project({
                    in: q.in,
                    algorithm: q.algorithm,
                    maxBytes: undefined,
                    env: undefined,
                    path: undefined,
                    task: undefined,
                    includeProposed: undefined,
                    dir: undefined,
                }),
            ),
    );

    // 字节账：预算的单位是**字节**，而投影页只显示"这次投了多少" —— 看不出"哪个主题占了多少、
    // 为什么它进不来"。所以另取一次 status（它按 subject 给 bytes + expose 档 + full 是否超预算）。
    const [st, { refetch: refetchStatus }] = createResource(spec, (s) =>
        guard(diyService.diy.facts.status({ in: s, dir: undefined })),
    );
    const statusData = () => {
        const r = st();
        return r !== undefined && r.ok ? r.data : null;
    };
    const exposeSummary = () => {
        const d = statusData();
        if (d === null) return null;
        const count = (l: "full" | "index" | "none") => d.bySubject.filter((s) => s.expose === l).length;
        return {
            used: d.exposeBudget.used,
            limit: d.exposeBudget.limit,
            full: count("full"),
            index: count("index"),
            none: count("none"),
        };
    };

    /** 三个访问器（而不是在 JSX 里 `x()!.data!`）：联合类型只有一次收窄机会，取两次 TS 就窄不住 */
    // 取值**各调一次**（`x()?.ok ? x()!.data : null` 之所以不行：TS 不在两次调用之间收窄）
    const rawData = () => {
        const r = raw();
        return r !== undefined && r.ok ? r.data : null;
    };
    const rawErr = () => {
        const r = raw();
        return r !== undefined && !r.ok ? r.err : null;
    };
    const projData = () => {
        const r = proj();
        return r !== undefined && r.ok ? r.data : null;
    };
    const projErr = () => {
        const r = proj();
        return r !== undefined && !r.ok ? r.err : null;
    };

    /** 计数从原文侧拿（原文在，库就建了）；不另开一次 status 请求 —— 少一次往返，也不会两边不一致 */
    const fileCount = () => rawData()?.files.length ?? 0;

    return (
        <div class="space-y-2 text-body">
            <div class="flex flex-wrap items-center gap-2">
                <span class="badge badge-sm badge-ghost font-mono">facts</span>
                <Show when={rawData()}>
                    <span class="opacity-70">
                        {fileCount()} 篇 · 词表 {rawData()!.subjects.length} 份
                    </span>
                </Show>
                <button
                    class={`btn btn-xs ml-auto ${mode() === "raw" ? "btn-active" : "btn-ghost"}`}
                    aria-pressed={mode() === "raw"}
                    title={mode() === "raw" ? "回到投影" : "看源文件（knowledge/facts/*.yaml 原文）"}
                    onClick={() => setMode(mode() === "raw" ? "projection" : "raw")}
                >
                    &lt;&gt;
                </button>
                <button
                    class="btn btn-ghost btn-xs opacity-60 hover:opacity-100"
                    title="刷新"
                    onClick={() => {
                        void refetchStatus();
                        void (mode() === "raw" ? refetchRaw() : refetchProj());
                    }}
                >
                    🔄
                </button>
            </div>

            <Show when={mode() === "raw"}>
                <Show
                    when={rawData()}
                    fallback={
                        <Show when={rawErr()} fallback={<div class="opacity-50">读取中…</div>}>
                            <div class="text-warning whitespace-pre-wrap break-all">{rawErr()}</div>
                        </Show>
                    }
                >
                    {(data) => (
                        <Show
                            when={data().exists}
                            fallback={
                                <div class="opacity-60">
                                    库是空的（<code class="font-mono">{data().dir}</code>）—— 第一次 <code class="font-mono">diy facts submit --in {spec()}</code> 会写在这里（目录自动建）。
                                </div>
                            }
                        >
                            <For each={data().files}>
                                {(f) => (
                                    <div class="space-y-1">
                                        <div class="font-mono opacity-60">{f.name}</div>
                                        <CodeBlock code={f.text} lang="yaml" />
                                    </div>
                                )}
                            </For>
                            <For each={data().subjects}>
                                {(s) => (
                                    <details class="mt-2">
                                        <summary class="cursor-pointer opacity-60 font-mono">{s.name}</summary>
                                        <div class="mt-1">
                                            <CodeBlock code={s.text} lang="yaml" />
                                        </div>
                                    </details>
                                )}
                            </For>
                        </Show>
                    )}
                </Show>
            </Show>

            <Show when={mode() === "projection"}>
                <Show when={exposeSummary()}>
                    {(x) => (
                        <div class="flex flex-wrap items-center gap-2 text-xs">
                            <span class={`badge badge-sm ${x().used > x().limit ? "badge-error" : "badge-ghost"} font-mono`} title="full 档的字节和 / 预算（超了 submit 与 check 都会报错）">
                                full {x().used} / {x().limit} B
                            </span>
                            <span class="opacity-70 font-mono">
                                full {x().full} · index {x().index} · none {x().none}
                            </span>
                        </div>
                    )}
                </Show>
                <div class="flex flex-wrap items-center gap-2">
                    <select
                        class="select select-xs select-bordered font-mono"
                        value={algo()}
                        onChange={(e) => setAlgo(e.currentTarget.value as Algo)}
                    >
                        <For each={ALGOS}>{(a) => <option value={a.id}>{a.label}</option>}</For>
                    </select>
                    <Show when={projData()}>
                        <span class="opacity-70">
                            {projData()!.bytes} B · {projData()!.shown.length} 条
                            <Show when={projData()!.skipped.length > 0}>· 跳过 {projData()!.skipped.length}</Show>
                            <Show when={projData()!.problems.length > 0}>
                                · <span class="text-error">问题 {projData()!.problems.length}</span>
                            </Show>
                        </span>
                    </Show>
                </div>
                <Show
                    when={projData()}
                    fallback={
                        <Show when={projErr()} fallback={<div class="opacity-50">计算中…</div>}>
                            <div class="text-warning whitespace-pre-wrap break-all">{projErr()}</div>
                        </Show>
                    }
                >
                    {(p) => (
                        <div class="space-y-1">
                            <CodeBlock code={p().text} lang={p().algorithm === "md-list" ? "md" : "yaml"} />
                            <Show when={p().problems.length > 0}>
                                <ul class="text-error font-mono">
                                    <For each={p().problems}>{(x) => <li>{x.gid} — {x.code}{x.detail ? `: ${x.detail}` : ""}</li>}</For>
                                </ul>
                            </Show>
                            <div class="opacity-50">这就是要发给 LLM 的形态：变体已解析成当前值，按命名空间分组。</div>
                        </div>
                    )}
                </Show>
            </Show>
        </div>
    );
}

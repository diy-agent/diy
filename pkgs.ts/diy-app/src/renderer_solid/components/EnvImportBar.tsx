/**
 * EnvImportBar — 模型配置页的「环境变量导入」提示条。
 *
 * 形态对齐 FindBar / DynamicBar：页内一条、可关闭、不挡内容，**只提示不自动写**
 * （落盘只发生在点「导入」时，见 core/model-import 的三条约定）。
 *
 * 为什么四种状态都出条（##286）：一开始只在「有可导入项」时出现，结果是——用户配了
 * key 却没看到条，分不清「已经配好了」「env 里没有对应变量」「功能根本没跑」。
 * 现在一律给一句话：可导入（黄）/ 命中但均已在配置中（绿）/ 一个都没命中（灰）/ 扫描失败（红）。
 */
import { For, Match, Show, Switch } from "solid-js";
import type { EnvImportCandidate } from "../../shared/model-config";

export type EnvScanScope = { providers: number; vars: string[] };

export function EnvImportBar(props: {
    candidates: EnvImportCandidate[];
    /** 扫描面（provider 数 / 变量名）；扫描失败时 null */
    scanned: EnvScanScope | null;
    /** 扫描失败原因（null = 正常） */
    error: string | null;
    onImport: (providers: string[]) => void;
    onRetry: () => void;
    onDismiss: () => void;
}) {
    const importable = () => props.candidates.filter((c) => c.status === "importable");
    const already = () => props.candidates.filter((c) => c.status !== "importable");
    const vars = () => props.scanned?.vars ?? [];
    /** 条的颜色随状态走：红=扫描失败 · 黄=可导入 · 绿=已配齐 · 灰=零命中（信息，不是警告） */
    const tone = () =>
        props.error
            ? "border-error/30 bg-error/15"
            : importable().length > 0
              ? "border-warning/30 bg-warning/15"
              : props.candidates.length > 0
                ? "border-success/30 bg-success/10"
                : "border-base-300 bg-base-200/50";

    return (
        <div
            data-env-import-bar
            class={`flex flex-wrap items-center gap-2 rounded-box border px-2 py-1 text-sm ${tone()}`}
        >
            <Switch>
                {/* 扫描失败：别静默吞掉，给重试 */}
                <Match when={props.error}>
                    <span>⚠️ 环境变量扫描失败：{props.error}</span>
                    <button class="btn btn-xs" onClick={props.onRetry}>
                        重试
                    </button>
                </Match>

                {/* 可导入：列出候选，逐家或一键导入 */}
                <Match when={importable().length > 0}>
                    <span>🔑 检测到 {importable().length} 个可由环境变量导入的 provider：</span>
                    <For each={importable()}>
                        {(c) => (
                            <span class="flex items-center gap-1 rounded-field bg-base-100 px-1.5 py-0.5">
                                <code class="font-mono text-xs">{c.provider}</code>
                                <span class="text-xs opacity-60">${c.envVar}</span>
                                <button
                                    class="btn btn-xs btn-ghost"
                                    title={`导入 ${c.provider}（账号写为 $${c.envVar} 引用）`}
                                    onClick={() => props.onImport([c.provider])}
                                >
                                    导入
                                </button>
                            </span>
                        )}
                    </For>
                    <button class="btn btn-xs btn-primary" onClick={() => props.onImport([])}>
                        全部导入
                    </button>
                </Match>

                {/* 命中但都被跳过：说清为什么不用导（已配置 / 密钥重复 / 同源） */}
                <Match when={props.candidates.length > 0}>
                    <span>
                        ✅ 环境变量命中的 {props.candidates.length} 家 provider 均已配置
                        （同一个密钥不重复配）：
                    </span>
                    <For each={already()}>
                        {(c) => (
                            <span class="rounded-field bg-base-100/60 px-1.5 py-0.5 text-xs">
                                <code class="font-mono">{c.provider}</code>
                                <span class="opacity-50"> ${c.envVar}</span>
                                <span class="opacity-60"> · {c.note}</span>
                            </span>
                        )}
                    </For>
                </Match>

                {/* 零命中：交代扫描面（查过什么）+ 怎么让密钥被扫到，别让用户对着空白猜 */}
                <Match when={true}>
                    <span>
                        ℹ️ 本机环境变量里没有可导入的 provider 密钥 —— 已核对 models.dev 声明的{" "}
                        {props.scanned?.providers ?? 0} 家 provider / {vars().length} 个变量名。
                    </span>
                    <span class="text-xs opacity-60">
                        密钥要以同名环境变量启动实例才会被扫到（如 <code>OPENCODE_API_KEY</code>
                        ）；也可在下方搜索 provider 手动添加。
                    </span>
                </Match>
            </Switch>

            {/* 对照用：models.dev 到底声明了哪些变量名（拼写自查） */}
            <Show when={vars().length > 0 && importable().length === 0}>
                <details class="w-full">
                    <summary class="cursor-pointer text-xs opacity-60">
                        查看 models.dev 声明的变量名（{vars().length}）
                    </summary>
                    <div class="mt-1 max-h-32 overflow-y-auto font-mono text-xs leading-5 opacity-70">
                        <For each={vars()}>{(v) => <span class="mr-3 inline-block">{v}</span>}</For>
                    </div>
                </details>
            </Show>

            <button class="btn btn-xs btn-ghost" title="关闭提示" onClick={props.onDismiss}>
                ✕
            </button>
        </div>
    );
}

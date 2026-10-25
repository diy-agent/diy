// components/InputLimitDialog.tsx — 超长输入的**发送前门禁**（##426 B）。
//
// 为什么要有它：一条 300 KB 的粘贴 = 单步输入 ~21.6 万 token、$0.03，**且此后每轮都重带**
// （它在历史里）。发送前是唯一能拦的位置，而"拦"不能只是拒绝 ——
// 用户真正想要的是"这段内容让 agent 看到"，不是"花 3 分钱把它塞进每一轮"。
//
// 三个数必须都给（用户口径）：本条字符数 / 估算 token（+ 预计成本增量）/ 当前窗口占用。
// 两个动作：**转文件发送**（内容落 `gen/paste/`，消息里只带路径 + 前 20 行）/ **仍然发送**。
// 与 ConfirmDialog 的区别：这里不是破坏性确认，而是二选一的分流（所以不用 btn-error，
// 也不把焦点默认压在"取消"上 —— 没有"取消"这个语义，取消 = 点背景 / Esc / 继续编辑）。
import { onCleanup, onMount } from "solid-js";
import type { InputGate } from "../../shared/context/input-limit";

const fmtInt = (n: number) => n.toLocaleString("en-US");
// 成本永远不许显示成 "$0.0000"（那与"免费"无法区分，正是本门禁要防的"看着不要钱"）：
// 有价目但极小 → "<$0.0001"；无价目 → 明确写出来。
const fmtCost = (v: number | null) => {
    if (v == null) return "—（无价目）";
    if (v <= 0) return "$0";
    if (v < 0.0001) return "<$0.0001";
    return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;
};

export function InputLimitDialog(props: {
    gate: InputGate;
    /** 转文件进行中（按钮置灰，避免重复落盘） */
    busy: boolean;
    onCancel: () => void;
    onToFile: () => void;
    onStillSend: () => void;
}) {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            props.onCancel();
        }
    };
    onMount(() => document.addEventListener("keydown", onKey, true));
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
    const pct = () => {
        const r = props.gate.windowRatio;
        return r == null ? "—（窗口未知）" : `${(r * 100).toFixed(1)}%`;
    };
    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onCancel();
            }}
        >
            <div class="bg-base-100 rounded-xl w-full max-w-lg flex flex-col" data-input-gate>
                <div class="px-4 py-3 border-b font-bold text-title">这条消息太长了（超过 {fmtInt(props.gate.limitChars)} 字符）</div>
                <div class="px-4 py-3 text-body flex flex-col gap-2">
                    <div class="text-sm opacity-80">
                        它会整段进上下文并留在历史里 —— 此后每一轮都按它计费。三个数：
                    </div>
                    <ul class="text-sm flex flex-col gap-1" data-input-gate-numbers>
                        <li>
                            本条：<b>{fmtInt(props.gate.chars)}</b> 字符 · 估算 <b>{fmtInt(props.gate.estTokens)}</b> token
                        </li>
                        <li>
                            本轮预计成本增量：<b data-input-gate-cost>{fmtCost(props.gate.costIncrement)}</b>
                        </li>
                        <li>
                            当前窗口占用（加本条后）：<b data-input-gate-window>{pct()}</b>
                            <span class="opacity-60">（上限 {props.gate.contextLimitTokens == null ? "未知" : fmtInt(props.gate.contextLimitTokens)} token）</span>
                        </li>
                    </ul>
                    <div class="text-sm opacity-70">
                        选「转文件发送」：内容存进本任务的 <code>gen/paste/</code> 目录，消息里只带路径 + 前 20 行 +
                        总行数/字节数 —— 模型需要细节时自己去读文件。
                    </div>
                </div>
                <div class="px-4 py-2 border-t flex justify-end gap-2">
                    <button class="btn btn-xs" onClick={props.onCancel}>
                        继续编辑
                    </button>
                    <button class="btn btn-xs" data-input-gate-still onClick={props.onStillSend}>
                        仍然发送
                    </button>
                    <button
                        class="btn btn-primary btn-xs"
                        data-input-gate-file
                        disabled={props.busy}
                        onClick={props.onToFile}
                    >
                        转文件发送
                    </button>
                </div>
            </div>
        </div>
    );
}

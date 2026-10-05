/**
 * 抽屉最大化 —— 贴顶 drawer 共用的「默认高 ⇄ 占满可视高」切换。
 *
 * 为什么抽出来：贴顶 drawer 在项目里有好几处（压缩面板 / 用量三抽屉 / 人物面板），
 * 各自长高需求一致。给一个 hook + 按钮，各处只挂进去，避免各写一份高度逻辑。
 *
 * 用法：
 *   const dm = useDrawerMax(66.666);           // 默认 2/3 屏
 *   <div class="relative flex min-h-0 flex-col ..." style={dm.style()}>
 *     ... <DrawerMaxButton max={dm.max()} onToggle={dm.toggle} />
 */
import { createSignal, type Accessor } from "solid-js";
import { IconExpand, IconCollapse } from "./icons";

export interface DrawerMax {
    /** 当前是否最大化 */
    max: Accessor<boolean>;
    toggle: () => void;
    /** 挂到面板容器的 style（覆盖高度）：最大化 = 100vh，否则默认 vh */
    style: Accessor<{ height: string }>;
}

/** @param defaultVh 默认高度（视口百分比），如 66.666 */
export function useDrawerMax(defaultVh = 66.666): DrawerMax {
    const [max, setMax] = createSignal(false);
    return {
        max,
        toggle: () => setMax((v) => !v),
        style: () => ({ height: max() ? "100vh" : `${defaultVh}vh` }),
    };
}

/** 标题栏右侧的最大化/还原按钮（与各 drawer 的 ✕ 同排） */
export function DrawerMaxButton(props: { max: boolean; onToggle: () => void }) {
    return (
        <button
            class="btn btn-ghost btn-xs"
            aria-label={props.max ? "还原尺寸" : "最大化"}
            data-drawer-max={props.max ? "1" : "0"}
            data-tip={props.max ? "还原尺寸" : "最大化"}
            onClick={props.onToggle}
        >
            {props.max ? <IconCollapse class="h-4 w-4" /> : <IconExpand class="h-4 w-4" />}
        </button>
    );
}

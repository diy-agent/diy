/**
 * layoutStore — 布局层的用户偏好（几何 / view 可见性）。
 *
 * 为什么需要 signal 包一层：`Caches.*` 是 localStorage 字段（非响应式），
 * 而开合动作要立刻反映到界面上。这里做「signal 为真相、Caches 为持久化」，
 * 与 chat 密度 / 主题的既有做法一致。
 *
 * 将来用户可调的部分会扩大（view 归属重绑、area 尺寸），届时统一收进本 store，
 * 模型见 shared/grid-layout.ts 与 shared/view-registry.ts。
 */
import { createSignal } from "solid-js";
import { Caches } from "../lib/ui-state";

const [labOpen, setLabOpenSignal] = createSignal<boolean>(Caches.diy_lab_open.get());

export const layoutStore = {
    /** 试验场（底部 devtools viewarea）是否展开 */
    get labOpen(): boolean {
        return labOpen();
    },
    setLabOpen(v: boolean): void {
        setLabOpenSignal(v);
        Caches.diy_lab_open.set(v);
    },
    toggleLab(): void {
        layoutStore.setLabOpen(!labOpen());
    },
};

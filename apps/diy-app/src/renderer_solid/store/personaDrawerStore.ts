// personaDrawerStore.ts — 人物编辑抽屉（`PersonaDrawer`）的开关状态，提升为**可被 rpc 驱动**的单例。
//
// 为什么单独成 store（##518）：这个抽屉原先只有 `SidebarRoom` 里的 local signal，
// 于是 `diy.ui.*` 那套「rpc 操纵 UI 状态」的能力**够不到它** —— 想用意图测试验
// 「打开人物面板并改一个人」，只能起真窗口用 CDP 点鼠标（慢且脆）。
// 状态一旦落到模块级单例，renderer-actions 就能注册 openPersona，rpc 侧就通了。
//
// 只放**开关与选中项**；人物数据本身仍在 personas.yaml（经 agent.persona.* 读写）。

let open = false;
let target: string | null = null;
const subs = new Set<() => void>();

function notify(): void {
    for (const fn of subs) fn();
}

export const personaDrawerStore = {
    isOpen(): boolean {
        return open;
    },
    /** 当前编辑的人物 id（null = 没选） */
    target(): string | null {
        return target;
    },
    open(personaId?: string): void {
        if (personaId !== undefined) target = personaId;
        open = true;
        notify();
    },
    close(): void {
        open = false;
        notify();
    },
    subscribe(fn: () => void): () => void {
        subs.add(fn);
        return () => void subs.delete(fn);
    },
};

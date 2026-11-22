// Sidebar.tsx —— 侧栏的**壳**：宽度、收起、拖拽、头尾，以及「把注册来源铺出来」。
//
// 这里不再认识「项目 / 历史 / 未归属」：它们是三个 NavSource（`src/nav/`），和内建之外
// 注册进来的来源走同一条路。壳里只有一条规则 —— 按 order 铺开 `render(context)`。
//
// 为什么值得这么分：以前三块写死在这个文件里（607 行），想加「股票」「文档」这类容器
// 分区就只能继续改壳；而壳每改一次，宽度拖拽、收起态这些和内容无关的东西都要重测一遍。

import { PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import * as React from 'react';

import type { Room } from '../model';
import { useNavSources, type NavContext, type NavHost } from '../nav';
import { registerBuiltinNav } from '../nav/index';
import { useAddress } from '../store';

// 模块加载时注册内建来源（幂等）。放在这里而不是 App：侧栏是它们唯一的宿主，
// 谁渲染侧栏谁就该保证来源在 —— 少了这一步，侧栏会安静地空白，没有任何报错。
registerBuiltinNav();

// ── 侧栏宽度（用户：项目导航和聊天之间要能拖）───────────────────────────────
//
// 收起态（rail 56px）没有“可调的宽度”这回事 —— 那是一个图标列的固定尺寸，
// 手柄只在展开态渲染，否则拖了也看不见变化。
const SIDEBAR_W_KEY = 'entity-chat:sidebar-width';
const SIDEBAR_W_DEFAULT = 256;
const SIDEBAR_W_MIN = 200;
const SIDEBAR_W_MAX = 520;
/** 收起态宽度（rail）—— 一个图标 + 内边距，不参与拖拽 */
const SIDEBAR_RAIL_W = 56;

function clampWidth(px: number): number {
    if (!Number.isFinite(px)) return SIDEBAR_W_DEFAULT;
    return Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(px)));
}

/** 存过的宽度（脏数据/超范围一律夹回合法区间 —— 一个坏值不该让侧栏把聊天挤没） */
function loadWidth(): number {
    try {
        const raw = Number(localStorage.getItem(SIDEBAR_W_KEY));
        return raw > 0 ? clampWidth(raw) : SIDEBAR_W_DEFAULT;
    } catch {
        return SIDEBAR_W_DEFAULT;
    }
}

export function Sidebar({
    open,
    onToggle,
    onCreateProject,
    onCreateTask,
    onRequestDelete,
    onOpenSettings,
    widthMode = 'own',
}: {
    open: boolean;
    onToggle: () => void;
    onCreateProject: () => void;
    onCreateTask: (projectId: string) => void;
    onRequestDelete: (room: Room) => void;
    onOpenSettings: () => void;
    /**
     * 宽度归谁管。
     *
     * `own`（缺省）= 侧栏自己带宽度与右缘拖拽手柄，存 `localStorage`——整页 App 的形态。
     *
     * `fill` = 宽度交给外层容器（工作台的 dock area）：不写宽度、不渲染手柄。
     * 两边都管就是两个真源：宿主的 area 拖到 320，下一次挂载又被 localStorage 的 240
     * 盖回去，而且那根手柄与 area 的分屏线只差几像素、谁都拖不准。
     */
    widthMode?: 'own' | 'fill';
}) {
    // 壳只关心「当前地址」（来源们拿它判高亮）。rooms / 错误 / 会话这些不归它管：
    // 整份快照会让每次 emit（包含别的房间来了一条消息）都把整张侧栏重铺一遍。
    const address = useAddress();
    const sources = useNavSources();

    const [width, setWidth] = React.useState(loadWidth);
    /** 拖拽中：宽度跟着指针实时变，这时必须**摘掉 width 过渡**，否则宽度在鼠标后面追 */
    const [resizing, setResizing] = React.useState(false);
    const asideRef = React.useRef<HTMLElement | null>(null);
    /** 宽度与右缘手柄归不归自己管（见 `widthMode`） */
    const own = widthMode === 'own';
    /** 拖拽结束时落盘（拖的途中每帧都写 localStorage 是白费） */
    const persistWidth = React.useCallback((px: number) => {
        try {
            localStorage.setItem(SIDEBAR_W_KEY, String(px));
        } catch {
            /* 存储不可用：本次运行仍然生效，只是重启回到默认 */
        }
    }, []);

    const onGripDown = React.useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!open) return;
            event.preventDefault();
            const left = asideRef.current?.getBoundingClientRect().left ?? 0;
            // 指针捕获：拖到聊天区上、拖出窗口也不会丢 move 事件（拖选框不跟着断）
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
            let latest = width;
            const onMove = (ev: PointerEvent) => {
                latest = clampWidth(ev.clientX - left);
                setWidth(latest);
                // 拖拽时把 select 禁掉，否则指针经过行文字会顺手选一大片
                document.body.style.userSelect = 'none';
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = '';
                setResizing(false);
                persistWidth(latest);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        },
        [open, width, persistWidth],
    );

    // 来源只拿到壳的动作，不拿到整个 Sidebar 的 props（否则来源迟早会开始依赖
    // 「侧栏能干什么」，而壳就再也改不动了）
    const host = React.useMemo<NavHost>(
        () => ({ onCreateProject, onCreateTask, onRequestDelete, onExpandSidebar: onToggle }),
        [onCreateProject, onCreateTask, onRequestDelete, onToggle],
    );
    const navContext = React.useMemo<NavContext>(() => ({ open, address, host }), [open, address, host]);

    return (
        <aside
            ref={asideRef}
            // `relative` 是给右缘手柄的定位锚（absolute inset-y-0 right-0）：
            // 手柄盖在 border 上，视觉上就是「这条线能拖」。
            className={`relative flex flex-col overflow-hidden border-r ${own ? 'shrink-0' : 'min-w-0'} ${resizing ? '' : 'transition-[width] duration-200'}`}
            style={own ? { width: open ? width : SIDEBAR_RAIL_W } : undefined}
            data-sidebar-width={own ? (open ? width : SIDEBAR_RAIL_W) : undefined}
        >
            <div className={`flex items-center border-b py-3 ${open ? 'gap-2 px-3' : 'justify-center px-1'}`}>
                {open && (
                    <>
                        <span className="text-sm font-semibold">diy</span>
                        <span className="text-xs text-muted-foreground">容器对话</span>
                    </>
                )}
                <button
                    onClick={onToggle}
                    title={open ? '收起侧栏（⌘B）' : '展开侧栏（⌘B）'}
                    className={`rounded p-1 text-muted-foreground hover:bg-muted ${open ? 'ml-auto' : ''}`}
                >
                    {open ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {sources.map((source) => (
                    <React.Fragment key={source.id}>{source.render(navContext)}</React.Fragment>
                ))}
            </div>

            <div className={`flex items-center border-t py-2 ${open ? 'justify-between px-3' : 'justify-center'}`}>
                {open && (
                    <span className="text-[11px] leading-relaxed text-muted-foreground">
                        容器 = 一条对话；成员在容器内
                    </span>
                )}
                <button
                    onClick={onOpenSettings}
                    title="模型设置"
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                    <Settings className="size-4" />
                </button>
            </div>

            {/* 右缘拖拽手柄（就这样写，不抽组件）：让它在视觉上**盖住那条 border** ——
                「这条线能拖」比在旁边加一个可拖的小块更直接。双击复位到默认宽。
                收起态不渲染：那是一个图标列的固定尺寸，拖了也看不见变化。 */}
            {open && own && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="拖动调整侧栏宽度（双击复位）"
                    title="拖动调整侧栏宽度（双击复位）"
                    data-sidebar-grip
                    onPointerDown={onGripDown}
                    onDoubleClick={() => {
                        setWidth(SIDEBAR_W_DEFAULT);
                        persistWidth(SIDEBAR_W_DEFAULT);
                    }}
                    className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-foreground/10 active:bg-foreground/20"
                />
            )}
        </aside>
    );
}

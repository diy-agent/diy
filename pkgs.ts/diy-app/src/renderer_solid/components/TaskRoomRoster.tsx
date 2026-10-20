/**
 * TaskRoomRoster — 任务执行页**右栏**的房间成员栏（##166 §43.3 A / ##377 第 16 刀）。
 *
 * 定位：任务恒是一个 room（§28.7 G：room id = taskUri）⇒ 这个右栏就是「任务房间」的成员表。
 * 本刀（第 16 刀）它是**只读 + 邀请 + 焦点**三件事：
 *   · 看得见谁在房间里、此刻在干什么（L1）；
 *   · 能拉人（选人物 → 影子 task 作 backend）；
 *   · 点名字 = 设「当前接受者」。
 * **不碰发送路径** —— 任务页主输入框仍只对本任务的 agent 说（想对别人说：走侧边栏，
 * 或等第 17 刀把输入框改走 `room.post`）。
 *
 * 复用（口径 A「复用，别复制」）：
 *   · `RoomRoster` —— 成员列表本体（每人 2 行 / 点名字设焦点 / hover 浮层 / 点头像三级 / 邀请）；
 *   · `PersonaDrawer` —— 三级披露的人物编辑半截页（`initialPersona` 由本组件给）。
 *
 * 与侧边栏 `SidebarRoom` 的分工：那个是**全局助手 room**（id 自成一族、独立于路由，不打开任何
 * 任务时也在）；这个是**任务自己的 room**（id = taskUri、随任务页存在）。取数逻辑同构
 * （`room.create` 幂等 → `room.get` / `room.roster` → 2.5s 轮询；无推送通道）。
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import { shortName, type Room, type RoomMember } from "../../shared/room";
import { RoomRoster, type RosterMemberL1 } from "./RoomRoster";
import { PersonaDrawer } from "./PersonaDrawer";

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 轮询节奏：与侧边栏同一份（本切片无推送通道，见 ##166 §28.6 待决） */
const POLL_MS = 2500;

export function TaskRoomRoster(props: { uri: string }) {
    const [room, setRoom] = createSignal<Room | null>(null);
    const [roster, setRoster] = createSignal<RosterMemberL1[]>([]);
    const [err, setErr] = createSignal<string | null>(null);
    const [personaOpen, setPersonaOpen] = createSignal(false);
    const [personaTarget, setPersonaTarget] = createSignal<string | null>(null);

    /** L1 状态（`room.roster`）：读不到就空着 —— 它是附加信息，不该让成员列表跟着报错 */
    const loadRoster = async (id: string): Promise<void> => {
        try {
            const r = await diyService.diy.room.roster({ id });
            setRoster(r.members as RosterMemberL1[]);
        } catch {
            /* 下一轮再试 */
        }
    };

    const load = async (id: string, opts: { soft?: boolean } = {}): Promise<void> => {
        try {
            // limit: 1 —— 本栏只要成员表（事件流归 LocalChatPage 的时间线用）
            const r = await diyService.diy.room.get({ id, limit: 1 });
            setRoom(r.room);
            if (!opts.soft) setErr(null);
            void loadRoster(id);
        } catch (e) {
            if (!opts.soft) setErr(`读房间失败：${msgOf(e)}`);
        }
    };

    onMount(() => {
        const id = props.uri;
        void (async () => {
            try {
                // create 幂等：确保房间存在（成员表恒含「我」+ 主人格；主人格的 backend = 本任务）
                await diyService.diy.room.create({ id, title: undefined, human: undefined });
                await load(id);
            } catch (e) {
                setErr(`房间起不来：${msgOf(e)}`);
            }
        })();
    });

    onMount(() => {
        const t = setInterval(() => void load(props.uri, { soft: true }), POLL_MS);
        onCleanup(() => clearInterval(t));
    });

    const setFocus = async (m: RoomMember | null): Promise<void> => {
        try {
            setRoom(await diyService.diy.room.focus({ id: props.uri, member: m ? m.id : undefined }));
        } catch (e) {
            notificationStore.addToastLegacy("error", `设当前接受者失败：${msgOf(e)}`);
        }
    };

    const invite = async (personaId: string): Promise<void> => {
        if (!personaId) return;
        try {
            const r = await diyService.diy.room.invite({
                id: props.uri,
                persona: personaId,
                task: undefined,
                role: undefined,
            });
            notificationStore.addToastLegacy(
                "info",
                `已邀请 ${r.member.name}（${r.createdTask ? "新建影子任务" : "复用已有任务"} ${r.taskUri}）`,
            );
            await load(props.uri);
        } catch (e) {
            notificationStore.addToastLegacy("error", `邀请失败：${msgOf(e)}`);
        }
    };

    const removeMember = async (m: RoomMember): Promise<void> => {
        try {
            setRoom(await diyService.diy.room.removeMember({ id: props.uri, member: m.id }));
            await load(props.uri);
        } catch (e) {
            notificationStore.addToastLegacy("error", `移出失败：${msgOf(e)}`);
        }
    };

    /** 三级披露：点头像 → 人物编辑半截页（只对有 persona 的成员有效；人成员没有人物） */
    const openPersona = (m: RoomMember): void => {
        if (!m.persona) return;
        setPersonaTarget(m.persona);
        setPersonaOpen(true);
    };

    return (
        <div class="flex h-full flex-col overflow-hidden" data-task-room-roster>
            <div class={`flex shrink-0 items-center gap-2 border-b px-3 ${VIEW_BAR_H}`}>
                <span class="text-body font-bold tracking-wide opacity-60">成员</span>
                <div class="flex-1" />
                <Show when={room()?.focus}>
                    <span class="text-caption opacity-60" data-task-room-focus>
                        接受者 {shortName(room()!.focus!)}
                    </span>
                </Show>
            </div>
            <Show when={err()}>
                <div class="shrink-0 px-3 py-1 text-caption text-error">{err()}</div>
            </Show>
            <RoomRoster
                room={room()}
                roster={roster()}
                onFocus={(m) => void setFocus(m)}
                onInvite={(pid) => invite(pid)}
                onRemove={(m) => void removeMember(m)}
                onPersona={(m) => openPersona(m)}
                class="min-h-0 flex-1"
            />
            <PersonaDrawer
                open={personaOpen()}
                initialPersona={personaTarget()}
                onClose={() => {
                    setPersonaOpen(false);
                    void load(props.uri, { soft: true });
                }}
            />
        </div>
    );
}

/**
 * api-domains/room/impl.ts —— `room` 域的 handler（从 api-impl.ts 按行号切出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { HUMAN_MEMBER_ID, shortName } from "../../../../shared/room";
import { roomApi } from "./api";

export function bindRoom(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: roomApi,
        // 模块层由模块自己声明（room）：与 defineService(name: "diy.room") 等价
        handlers: {
            room: {
            list: async () => {
            const { listRooms, readEvents } = await import("../../../core/room");
            const rooms = [];
            for (const r of listRooms()) {
              // 只要最后一条 ⇒ 倒读 1 行（##427：不再是整份读 + 解析）
              const { events } = await readEvents(r.id, { limit: 1 });
              const last = events[events.length - 1];
              rooms.push({
                id: r.id,
                ...(r.title ? { title: r.title } : {}),
                focus: r.focus,
                members: r.members.length,
                ...(last ? { last: `${shortName(last.author)}: ${last.text.slice(0, 60)}` } : {}),
              });
            }
            return { rooms };
            },
            get: async ({ input }) => {
            // 走 readRoomViewCached（不是裸 readEvents）：投递状态在 deliveries.jsonl 里，要 fold 上来；
            // 缓存按文件签名失效 + 合并并发（##427：同一房间在同一次刷新窗口里被多个组件读多遍盘）
            const { readRoomViewCached } = await import("../../../core/room-view-cache");
            const { ensureRoomForTask } = await import("../../room-service");
            const { withSteerTurns } = await import("../../../../shared/room");
            const { getLocalAgent } = await import("../../local-agent");
            // 宿主定案（§28.7 G）：id = taskUri，且**每个任务恒是一个 room** ⇒ 读之前先补齐成员表
            await ensureRoomForTask(input.id);
            const { room, events, bad } = await readRoomViewCached(input.id, { limit: input.limit ?? 200 });
            // 忙时插话那条的 **turnId 是读侧投影**（##377 第 29 刀）：投递时只知道「插进了正在跑的那一轮」，
            // 队列项落位之后才有块带 `meta.steerId` ⇒ 现在问 `local-agent` 反查得到。
            // 不落盘：它不是事件事实，而是"拿着既有键（steerId）现算的地址"（owner 口径：别造回复映射）。
            const agent = getLocalAgent();
            const withTurns = withSteerTurns(events, (taskUri, steerId) => agent.steerTurnId(taskUri, steerId));
            return { room, events: [...withTurns], badLines: bad };
            },
            create: async ({ input }) => {
            const { isValidRoomId } = await import("../../../core/room");
            const { ensureRoomForTask } = await import("../../room-service");
            if (!isValidRoomId(input.id)) throw new Error(`房间 id 不合法：${input.id}（room id = 任务 URI）`);
            return await ensureRoomForTask(input.id);
            },
            addMember: async ({ input }) => {
            const { upsertMember } = await import("../../../core/room");
            const { ensureRoomForTask } = await import("../../room-service");
            const room = await ensureRoomForTask(input.id);
            const taskUri = input.task ?? "";
            // 护栏：**同一 backend 不得挂两个人物**（= A 帽子，##166 §27 已否）
            const dup = room.members.find((m) => m.backend?.type === "task" && m.backend.data.taskUri === taskUri && taskUri);
            if (dup) throw new Error(`会话 ${taskUri} 已挂了成员 ${dup.name}（同一 backend 不得挂两个人物）`);
            return upsertMember(input.id, {
              id: `agent:${input.name}`,
              name: input.name,
              kind: "agent",
              backend: { type: "task", data: { taskUri } },
              ...(input.persona ? { persona: input.persona } : {}),
              ...(input.role ? { role: input.role } : {}),
            });
            },
            invite: async ({ input }) => {
            const { upsertMember } = await import("../../../core/room");
            const { ensureRoomForTask } = await import("../../room-service");
            const { listPersonas } = await import("../../../core/persona");
            const { diyHome } = await import("../../../core/state");
            const room = await ensureRoomForTask(input.id);
            const personas = listPersonas(diyHome());
            const p = personas.find((x) => x.id === input.persona || x.name === input.persona);
            if (!p) throw new Error(`没有这个人物：${input.persona}（diy agent persona list 看可用人物）`);
            // 高级入口：指定绑已有 task；否则建影子 task（title 里带宿主任务，便于回溯）
            const given = input.task?.trim();
            let taskUri = given ?? "";
            let createdTask = false;
            if (!taskUri) {
              // 影子 task 落在**宿主任务所在的 project**（宿主不在本数据根时回落到第一个可用 project）——
              // "藏进专属 project"是 ##166 §28.7 D 的后话，探索期跑通优先。
              // 建法与 §30 侧边栏主人格**同一份**（room-service::createShadowTask），不各写一遍。
              const { createShadowTask } = await import("../../room-service");
              taskUri = await createShadowTask(input.id, p);
              createdTask = true;
            }
            const dup = room.members.find((m) => m.backend?.type === "task" && m.backend.data.taskUri === taskUri);
            if (dup) throw new Error(`会话 ${taskUri} 已挂了成员 ${dup.name}（同一 backend 不得挂两个人物）`);
            // 成员 id 用**人物名**（`@` 寻址的直觉就是喊名字；重名时加序号）；name 同名 —— UI 显示用
            const base = p.name.trim().replace(/\s+/g, "-");
            let memberId = `agent:${base}`;
            for (let n = 2; room.members.some((m) => m.id === memberId); n++) memberId = `agent:${base}-${n}`;
            const member = {
              id: memberId,
              name: p.name,
              kind: "agent" as const,
              persona: p.id,
              backend: { type: "task" as const, data: { taskUri } },
              ...(input.role ? { role: input.role } : {}),
            };
            const next = upsertMember(input.id, member);
            return { room: next, member, taskUri, createdTask };
            },
            removeMember: async ({ input }) => {
            const { readRoom, removeMember } = await import("../../../core/room");
            const { resolveMember } = await import("../../../../shared/room");
            const { ensureRoomForTask } = await import("../../room-service");
            await ensureRoomForTask(input.id);
            const room = readRoom(input.id);
            if (!room) throw new Error(`房间不存在：${input.id}`);
            const memberId = resolveMember(room, input.member);
            if (!room.members.some((m) => m.id === memberId)) throw new Error(`房间里没有这个成员：${input.member}`);
            return removeMember(input.id, memberId);
            },
            focus: async ({ input }) => {
            const { readRoom, setFocus } = await import("../../../core/room");
            const { ensureRoomForTask } = await import("../../room-service");
            const { resolveMember } = await import("../../../../shared/room");
            await ensureRoomForTask(input.id);
            const room = readRoom(input.id);
            if (!room) throw new Error(`房间不存在：${input.id}`);
            const member = input.member ? resolveMember(room, input.member) : null;
            if (member && !room.members.some((m) => m.id === member)) throw new Error(`房间里没有这个成员：${input.member}`);
            return setFocus(input.id, member);
            },
            read: async ({ input }) => {
            const { readRoom, markRead } = await import("../../../core/room");
            const advanced = await markRead(input.id, input.event);
            const room = readRoom(input.id);
            if (!room) return { room: null, advanced: false, read: null };
            const human = room.members.find((m) => m.kind === "human");
            const event = human ? room.lastSeen[human.id] : undefined;
            return {
              room,
              advanced,
              read: human && event ? { member: human.id, event } : null,
            };
            },
            post: async function* ({ input }) {
            const { postToRoom } = await import("../../room-service");
            for await (const ev of postToRoom(input.id, input.text)) yield JSON.stringify(ev);
            },
            turn: async ({ input }) => {
            const { readRoom, readRoomView } = await import("../../../core/room");
            const { ensureRoomForTask } = await import("../../room-service");
            const { resolveMember } = await import("../../../../shared/room");
            const { getLocalAgent } = await import("../../local-agent");
            const { sessionRegistry } = await import("../../session-registry");
            // 两种寻址：`(成员, 轮次)` 字面口径 ｜ `reply 事件 id` room 便利形态（事件自带 ref）
            let taskUri: string;
            let turnId: string;
            let memberUri: string | null = null;
            if (input.member && input.turn) {
              await ensureRoomForTask(input.id);
              const room = readRoom(input.id);
              if (!room) throw new Error(`房间不存在：${input.id}`);
              const memberId = resolveMember(room, input.member);
              const m = memberId ? room.members.find((x) => x.id === memberId) : undefined;
              if (!m) throw new Error(`房间里没有这个成员：${input.member}（room get 看成员表）`);
              const tu = m.backend?.type === "task" ? m.backend.data.taskUri : "";
              if (!tu) throw new Error(`成员 ${m.id} 没绑任务会话，没有进度可取（backend 缺 taskUri）`);
              taskUri = tu;
              turnId = input.turn;
              memberUri = m.id;
            } else {
              if (!input.event) throw new Error("要么给 --event（reply 事件 id），要么给 --member + --turn");
              // limit: 0 = **全量**（要按 id 反查任意一条历史事件，尾部窗口答不了 —— 这是人为操作、不是轮询）
              const { events } = await readRoomView(input.id, { limit: 0 });
              const ev = events.find((e) => e.id === input.event);
              if (!ev) throw new Error(`房间里没有这条事件：${input.event}（room get 看事件 id）`);
              const ref = ev.ref;
              if (!ref || !ev.sourceTask) throw new Error(`这条事件没有进度引用（不是被投递的 reply）：${input.event}`);
              taskUri = ev.sourceTask;
              turnId = ref.turnId;
              memberUri = ref.memberUri;
            }
            const agent = getLocalAgent();
            return {
              turn: agent.turnNode(taskUri, turnId),
              taskUri,
              turnId,
              memberUri,
              live: sessionRegistry.activeTurnList().some((t) => t.uri === taskUri),
              entry: sessionRegistry.entryOf(taskUri),
              action: agent.currentAction(taskUri),
            };
            },
            roster: async ({ input }) => {
            const { readRoom } = await import("../../../core/room");
            const { readDeliveriesCached } = await import("../../../core/room-view-cache");
            const { ensureRoomForTask } = await import("../../room-service");
            const { getLocalAgent } = await import("../../local-agent");
            const { sessionRegistry } = await import("../../session-registry");
            const { memberAvatar, memberColor, orderedMembers } = await import("../../../../shared/room");
            await ensureRoomForTask(input.id);
            const room = readRoom(input.id);
            if (!room) throw new Error(`房间不存在：${input.id}`);
            // 本端点只要「谁在排队 / 谁在跑」⇒ 直接吃 deliveries 的 fold（**不碰事件流**）：
            // 旧实现为这几个计数把整条事件流读了一遍（limit: 0 = 全量，5 MB 时每次轮询 ~百 ms 级）。
            const { byEvent } = await readDeliveriesCached(input.id);
            const states = [...byEvent.values()].flatMap((inner) => [...inner.values()]);
            const agent = getLocalAgent();
            const members = orderedMembers(room).map((m, i) => {
              const taskUri = m.backend?.type === "task" ? m.backend.data.taskUri || null : null;
              let queued = 0;
              let running = 0;
              for (const d of states) {
                if (d.memberId !== m.id) continue;
                if (d.status === "queued") queued++;
                else if (d.status === "running") running++;
              }
              return {
                memberId: m.id,
                name: m.name,
                avatar: memberAvatar(m, i),
                color: memberColor(m),
                role: m.role ?? (m.kind === "human" ? "人类（房间主人）" : "agent"),
                isHuman: m.kind === "human",
                focus: room.focus === m.id,
                taskUri,
                entry: taskUri ? sessionRegistry.entryOf(taskUri) : null,
                action: taskUri ? agent.currentAction(taskUri) : null,
                queued,
                running,
              };
            });
            return { room: room.id, now: Date.now(), members };
            },
        } },
    });
}

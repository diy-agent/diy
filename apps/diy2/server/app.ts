// server/app.ts —— diy2 的 HTTP/SSE 适配层：**只产出 handler，不 listen**。
//
// 领域逻辑全在 `RoomActor`（entity-runtime/src/room.ts）：成员、路由、结论、
// 回合与顺序、会话池、压缩。这里只做四件事：
//   1. 解析请求 / 回 JSON
//   2. 房间订阅（同一房间多个请求共享一条 SSE）
//   3. 把 RoomActor 的事件转成 SSE
//   4. 进程内的房间与 bot 装配（种子数据）
//
// 为什么不再是「import 即 listen」（##dev-app 构建对齐）：老写法把「监听哪个端口 / 读哪个
// 数据根 / 要不要静态服务」焊死在模块顶层，于是三个入口（bin/diy2、tsx 直跑、vite）各写一份
// 装配逻辑，端口散在 5 处。现在端口 / 数据根 / 变体只从 `./config` 来（唯一真源），
// 监听由调用方做：`server/index.ts`（生产）、`server/dev.ts`（单端口 dev）、`bin/diy2`（全局命令）。

import { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import { createStaticHandler, type StaticHandler } from './static';
import { createRpcSocket, type RpcStreamInfo } from './rpc';
import { configureSlowLog, startLoopLag, timed, type LoopLagMonitor } from './loop-lag';
import { APP_ID, type Diy2Config } from './config';
import { openLog } from './log';

import {
    RoomActor,
    createJobRegistry,
    createCachedTurnLookup,
    defaultModelKeyOf,
    modelProviders,
    newEntityId,
    openStore,
    snapshotPath,
    sourceQuotesOf,
    unitBoard,
    unitsContextText,
    type RunCodeHost,
    withSourceQuotes,
} from '@diy-agent/entity-runtime';
import type { CompactEvent, RoomEvent } from '@diy-agent/entity-runtime';
import {
    ChannelClientBinding,
    ChannelServerBinding,
    _flattenRouter,
    createMemTransportPair,
    createTypedClient,
    type HandlersOf,
} from '@diy-agent/rpc';
import { createBlobStore, parseAttachmentRef, parseAttachmentRefs } from '@diy-agent/attachment';
import { apiHelpOf, defaultCodeRuntime } from '@diy-agent/code-runtime';
import { METHOD_DESC, diy2Api } from '@diy-agent/protocol';
import { botOfProfile, membersOfType } from '@diy-agent/protocol';
import type {
    ActivityFrame,
    AskAnswer,
    AskQuestionAnswer,
    AskRequest,
    Author,
    Bot,
    BotProfile,
    Item,
    BotProfileDefaults,
    JobRunRow,
    ModelConfigSnapshot,
    Room,
    RoomMember,
} from '@diy-agent/protocol';
import {
    availableProviders,
    removeAccount as dropAccount,
    removeProvider as dropProvider,
    renameAccount as relabelAccount,
    saveAccount as writeAccount,
    saveDefaultModel as writeDefaultModel,
    saveProvider as writeProvider,
} from '@diy-agent/model-catalog';

/** 装配层（index / dev）已经装好 provider；这里取句柄。未装时是 noop，不报错。 */
const log = openLog('app');

/**
 * 新房间 / 新 bot 落库时的模型值：`model.yaml` 的 `defaultModel`，**没配置就存空串**。
 *
 * 曾经这里存的是一个占位 key（`none@none/none`）—— 想靠它把「没配置」变成一次响亮失败。
 * 真跑起来才发现它是**会被写进 sqlite 的**：房间和 bot 的行比配置活得久，于是后补了
 * model.yaml 之后那些行仍然指着占位 key，发不出去、界面上还显示成真的模型名（实测：
 * 「none · none@none」，看着像配好了）。
 *
 * 现在的口径：**行里只存人选的**，空串 = 用目录的 defaultModel（解析在 `modelOf` 里）。
 * 这样配置后补也能「自愈」 —— 行不用动，缺省在发送时现算。
 */
function persistedDefaultModelKey(): string {
    return defaultModelKeyOf() ?? '';
}
/**
 * 配置页的整页快照（`diy2.models.config`，也是每个写方法的回包）。
 *
 * 与 `models.list` 分开的理由写在协议里（一个要「现在能选什么」、一个要「目录里还有什么」）。
 * 这里**永不含 key 值** —— 账号只有名字 / 填没填 / 字符数，那是 catalog 读侧的硬边界。
 */
function modelConfigView(): ModelConfigSnapshot {
    const defaultModelKey = defaultModelKeyOf();
    return {
        home: config.home,
        modelConfigPath: config.modelConfigPath,
        snapshotMissing: !existsSync(snapshotPath(config.home)), // sync-io-ok: 同步自报「快照在不在」，只判文件存在与否
        ...(defaultModelKey === undefined ? {} : { defaultModelKey }),
        providers: availableProviders(config.home).map((provider) => ({
            id: provider.providerId,
            name: provider.name,
            kind: provider.kind,
            configured: provider.configured,
            ...(provider.api === undefined ? {} : { api: provider.api }),
            ...(provider.npm === undefined ? {} : { npm: provider.npm }),
            envKeys: [...provider.envKeys],
            ...(provider.doc === undefined ? {} : { doc: provider.doc }),
            accounts: provider.accounts.map((account) => ({
                name: account.name,
                configured: account.configured,
                env: account.env,
                ...(account.chars === undefined ? {} : { chars: account.chars }),
            })),
            models: provider.models.map((model) => ({
                id: model.id,
                name: model.name,
                ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
                ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
                ...(model.cost === undefined ? {} : { cost: model.cost }),
                ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
                ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
                enabled: model.enabled,
            })),
        })),
    };
}

/** 写方法的入参口径：宽容取字段，类型不对就让下游（catalog）报错 —— 它才是 YAML 的主人 */
function argsOf(input: unknown): Record<string, unknown> {
    return typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
}

function textArg(args: Record<string, unknown>, field: string): string {
    const value = args[field];
    if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
    return value;
}

/** 提问卡草稿：提问早就有了结局（或从时间线上消失）这么久，就不再算"未提交输入" */
const ASK_DRAFT_TTL = 30 * 60 * 1000;
/** 对话框草稿：synthetic owner 不随房间级联删，超过这么久没人再来就清掉 */
const DIALOG_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
const HUMAN: Author = { id: 'human:我', name: '我', color: '#9ca3af', role: 'human' };

/**
 * 批量重试发的那句话。
 *
 * 跟 `endItems` 里给的 advice 同一措辞（「说「继续」接上」）—— 用户看到的建议和真的按下
 * 去发出去的是同一句话，否则「它说让我说继续，我点重试，结果发了别的东西」。
 */
const RETRY_TEXT = '继续';
const COLORS = ['#7cc4ff', '#f7b267', '#a3e635', '#f472b6', '#c084fc', '#38bdf8'];

/**
 * 装配期状态：原本是模块顶层的 const（import 即装配 → import 即 listen）。
 * 现在由 `createDiy2App(config)` 一次写入 —— 一个进程只装一次（dev 改服务端代码靠重启进程，
 * 不靠热替换），所以模块级 let 足够；把 700 行闭包化只会淹掉真正的改动。
 */
let config: Diy2Config;
let store: ReturnType<typeof openStore>;
let serveStatic: StaticHandler | undefined;
/** `/api/info` 的回包工厂（由 `createDiy2App` 装配：端口要问调用方，模块层答不出） */
let info: () => Diy2AppInfo;
/** 事件循环延迟监控（./loop-lag）：`/api/metrics` 读它，close 时停 */
let lagMonitor: LoopLagMonitor | undefined;

// ─── 房间装配 ─────────────────────────────────────────────────────

/** roomId → 聚合根（房间的领域对象） */
let rooms = new Map<string, RoomActor>();
/**
 * 后台作业账本：**进程级一张表**（`bash(background)` 起的 run 与 `job` 工具查的是同一份）。
 * 收口通知按归属串 `<roomId>#<botId>` 回到对应房间 —— 房间不在（已删 / 别的进程起的）就静默。
 */
let jobs: ReturnType<typeof createJobRegistry>;
/**
 * `run_code` 的执行器 + 进程内 RPC client。
 *
 * **模块级**而不是 `createDiy2App` 里的局部量：`actorOf` 是模块级函数（被 `seed()` 提前调），
 * 房间的工具集是惰性装配的（第一次 turn 才 `toolsFor`），所以这里只要在首个 turn 之前
 * 赋值就够——赋值点在建完 handlers 之后（那时才拿得到 `bindDiy2Api`）。
 */
let codeHost: RunCodeHost | undefined;
/**
 * 话题上推的帧：房间领域事件 + 传输层的收尾帧。
 *
 * `done` 不属于房间（`RoomEvent` 里剔除它），它是「这条话题到头了」的传输层信号 ——
 * 以前「一条流一个房间」时靠关连接表达，现在连接是共用的，只能靠帧说。
 */
type RoomFrame = RoomEvent | { kind: 'done' };

/**
 * 一条房间事件的去向。以前它就是「一个 ServerResponse = 一条连接」，于是
 * 「谁在看这个房间」和「谁占着一条连接」是同一件事 —— 多页工作台必然撑爆连接数。
 * 现在它只是个函数：多路复用的那条连接把它写成一帧带话题的 SSE（见 ./stream）。
 */
type Sink = (event: RoomFrame) => void;
let subscribers = new Map<string, Set<Sink>>();

function attach(roomId: string, sink: Sink): () => void {
    let set = subscribers.get(roomId);
    if (set === undefined) {
        set = new Set();
        subscribers.set(roomId, set);
    }
    set.add(sink);
    return () => {
        set?.delete(sink);
        if (set !== undefined && set.size === 0) subscribers.delete(roomId);
    };
}

function broadcast(roomId: string, payload: RoomFrame): void {
    for (const sink of subscribers.get(roomId) ?? []) sink(payload);
}

// ─── 全局活动（实例级，不属于任何房间）───────────────────────────

/**
 * 「谁在跑」的实例级订阅者。与 `subscribers` 分开：那张表按房间分，这张是全实例一条流。
 */
let activitySinks = new Set<(frame: ActivityFrame) => void>();
/** 上一次推过的内容（序列化后）：running 与作业起停会撞在一起，内容没变就别发 */
let lastActivityKey = '';

/**
 * 这一刻的活动快照：有成员在跑的房间 + 在跑的作业数。
 *
 * 两个真源都是**已经算好的**（`actor.runningBots()` / `jobs.list()`），这里不另算一套 ——
 * 房间流与作业账本各说自己那半，这个函数只负责把它们汇成一条给标题栏的帧。
 */
function activityFrame(): ActivityFrame {
    return {
        kind: 'activity',
        rooms: [...rooms.values()]
            .map((actor) => ({ id: actor.spec.id, botIds: actor.runningBots() }))
            .filter((row) => row.botIds.length > 0),
        jobs: jobs.list().filter((run) => run.state === 'running').length,
    };
}

/**
 * 推一次全局活动。**没人订阅就算也不算**（不留 lastActivityKey，下次有人来时任它真值）。
 *
 * 新订阅者的首帧由 `attachActivity` 自己给，不依赖这里 —— 两条路才是「打开页面就有数」。
 */
function broadcastActivity(): void {
    if (activitySinks.size === 0) return;
    const frame = activityFrame();
    const key = JSON.stringify(frame);
    if (key === lastActivityKey) return;
    lastActivityKey = key;
    for (const sink of activitySinks) sink(frame);
}

function attachActivity(sink: (frame: ActivityFrame) => void): () => void {
    // 首帧 = 当前快照：已经有一轮在跑时新开的页面不该等到下一次变化才亮
    sink(activityFrame());
    activitySinks.add(sink);
    return () => {
        activitySinks.delete(sink);
    };
}

/** 房间的工作目录：自己的 data.dir，任务则继承所属项目 */
function cwdOf(spec: Room): string | undefined {
    const own = spec.data['dir'];
    if (typeof own === 'string' && own !== '') return expandHome(own);
    const projectId = spec.data['projectId'];
    const parent =
        typeof projectId === 'string' ? [...rooms.values()].find((actor) => actor.spec.id === projectId) : undefined;
    const parentDir = parent?.spec.data['dir'];
    return typeof parentDir === 'string' && parentDir !== '' ? expandHome(parentDir) : undefined;
}

function expandHome(dir: string): string {
    return dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir;
}

/** 关系里「另一边」怎么显示：任务 `#12 标题`、项目名字、其它实体（未来的插件类型）退回 id */
function labelOf(id: string): { label: string; type: string } {
    const task = store.taskOf(id);
    if (task !== undefined) return { label: `#${task.number} ${task.title}`, type: 'task' };
    const project = store.projectOf(id);
    if (project !== undefined) return { label: project.name, type: 'project' };
    return { label: id, type: store.entityOf(id)?.type ?? 'unknown' };
}

/**
 * 把**库侧派生**的只读字段抄回内存 spec（`Room.data.number` / `data.taskDir`）。
 *
 * 这两个值都不是调用方给的，而只能由 store 算出来：
 * · `number` —— `counters` 在**落库那一刻**才发号（永不回收）；
 * · `taskDir` —— 由创建日派生（`<数据根>/tasks/<日期>/<id>`，不落库）。
 * 而内存那份 `Room` 是 server 手写的投影（`create` / `seed`），手写的地方不可能知道它们。
 * 不抄回来的话，`rooms.list` 给出的任务就一直缺这两个键 —— 侧栏没有 `#号`（UI 读
 * `data.number`，见 entity-chat 的 `taskNumberOf`）、详情面板的「任务目录」显示「—」；
 * 重启时 `seed()` 从库里重读才补上。用户报的「新任务没有 number」就是这个窗口
 * （库与磁盘上的 `task.md` 一直是对的，所以只有界面上看得见）。
 */
function adoptDerived(spec: Room): void {
    if (spec.type !== 'task') return;
    const task = store.taskOf(spec.id);
    if (task === undefined) return;
    if (spec.data['number'] !== task.number) spec.data['number'] = task.number;
    const dir = store.taskDirOf(spec.id);
    if (dir !== undefined && spec.data['taskDir'] !== dir) spec.data['taskDir'] = dir;
}

function actorOf(spec: Room): RoomActor {
    let actor = rooms.get(spec.id);
    if (actor === undefined) {
        const cwd = cwdOf(spec);
        actor = new RoomActor({
            spec,
            store,
            // 房间向所有角色要身份：成员名单里只有该类型的角色，多给无害（members 按 spec 过滤）
            bots: () => store.listBotProfiles().map((role) => botOfProfile(role, store.getBotProfileDefaults(role.type))),
            emit: (event) => {
                broadcast(spec.id, event);
                // turn 起停 = 全实例「谁在跑」的开销点：标题栏那颗图标与侧栏每一行都靠这个
                if (event.kind === 'running') broadcastActivity();
            },
            budget: config.compact,
            onCompact: (bot, event) => logCompact(spec.id, bot, event),
            ...(cwd === undefined ? {} : { cwd }),
            home: config.home,
            // 设备库住生产根（`~/.diy2/knowledge`），不跟着 lab 的实例根漂
            deviceHome: config.deviceHome,
            // 传 thunk 不传值：`seed()` 建 actor 时 `codeHost` 还没赋值（见 `RoomActorDeps.code`）
            code: () => codeHost,
            shell: config.tools !== 'files',
            jobs: { registry: jobs },
            ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
            ...(config.bashTimeoutMs === undefined ? {} : { bashTimeoutMs: config.bashTimeoutMs }),
        });
        rooms.set(spec.id, actor);
        // 运行时新建的容器也要落库：不落的话重启后侧栏里就没了（消息还在，只是没入口）
        store.saveRoom(spec);
        // 落库之后派生值才存在（见上）：内存 spec 是这次 list 的来源，必须当场补齐
        adoptDerived(spec);
    }
    return actor;
}

/**
 * 账本里的一条 → 界面画的那一条（`diy2.jobs.list` 的项）。
 *
 * 时间基准取**现在**：运行中的那条每次拉都该长一点（界面那个秒表靠它跳），
 * 而终态的时长就定在 `endedAt` 上 —— 两者不是一个公式，不能图省事都传 startedAt。
 */
function jobRowOf(info: ReturnType<ReturnType<typeof createJobRegistry>['list']>[number]): JobRunRow {
    const now = Date.now();
    const end = info.endedAt ?? now;
    return {
        id: info.id,
        state: info.state,
        startedAt: info.startedAt,
        ...(info.endedAt === undefined ? {} : { endedAt: info.endedAt }),
        durationMs: Math.max(0, end - info.startedAt),
        command: info.command,
        ...(info.title === undefined ? {} : { title: info.title }),
        cwd: info.cwd,
        logPath: info.logPath,
        ...(info.pid === undefined ? {} : { pid: info.pid }),
        ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
        ...(info.signal === undefined ? {} : { signal: info.signal }),
        ...(info.error === undefined ? {} : { error: info.error }),
        // 只报「确实没人接」：true / undefined 都不写，界面只在能报警时才多一个标记
        ...(info.delivered === false ? { delivered: false } : {}),
        ...(info.origin === undefined
            ? {}
            : {
                  origin: {
                      taskUri: info.origin.taskUri,
                      ...(info.origin.turnId === undefined ? {} : { turnId: info.origin.turnId }),
                  },
              }),
    };
}

/** 压缩是一等事件：改预算前先看这行 */
function logCompact(roomId: string, bot: Bot, event: CompactEvent): void {
    const before = `${event.before.entries}msgs/${event.before.chars}c`;
    const after = `${event.after.entries}msgs/${event.after.chars}c`;
    const usage = event.usage === undefined ? '' : ` usage=${event.usage.inputTokens}/${event.usage.outputTokens}`;
    log.info(`压缩 ${bot.name} @${roomId}`, {
        turn: event.turn,
        strategy: event.strategy,
        before,
        after,
        dropped: event.dropped,
        durationMs: event.durationMs,
        ...(event.usage === undefined ? {} : { usage }),
    });
}

function roomOf(id: string): RoomActor | undefined {
    return rooms.get(id);
}

/** RPC 版取房间：不存在就抛（HTTP 路由那边是 json 404，这里是异常） */
function requireRoom(id: string): RoomActor {
    const actor = roomOf(id);
    if (actor === undefined) throw new Error(`房间不存在：${id}`);
    return actor;
}

/** 房间的显示名：任务标题 / 项目名（Room 自己没有 name，见 protocol 里那段注释） */
function roomTitleOf(room: Room): string {
    const title = room.data['title'];
    if (typeof title === 'string' && title !== '') return title;
    const name = room.data['name'];
    return typeof name === 'string' && name !== '' ? name : room.id;
}

// ─── 种子：bot 落 sqlite；项目/任务先在内存 ────────────────────────

/**
 * 种子：角色进 `bot_roles`；示例容器（两个项目 + 一个任务）只在**全新数据根**里建。
 *
 * 角色是类型级的，所以这里只建「每类默认席位」，不建「每容器一个 bot」——
 * 老库的 35 个 bot 已由 db.ts 的 migrateBots 折成角色，不会走到这里。
 */
function seed(): void {
    if (store.listBotProfiles().length === 0) {
        newRole({
            type: 'project',
            name: '主程',
            instructions: '工程视角：先结论后理由，改动要给影响面与回滚。',
        });
        newRole({ type: 'project', name: '产品', instructions: '产品视角：拆需求、找边界、写验收。' });
        newRole({
            type: 'task',
            name: '任务助手',
            instructions: '任务视角：可观测性与回滚，做完要能自己验。',
        });
    }

    const specs: Room[] = [
        {
            id: 'proj:diy',
            type: 'project',
            data: { name: 'diy', dir: '~/git/diy/diy' },
            members: membersOf('project'),
        },
        {
            id: 'proj:cops',
            type: 'project',
            data: { name: 'cops', dir: '~/git/cops' },
            members: membersOf('project'),
        },
        {
            id: 'task:t-001',
            type: 'task',
            data: { title: '任务树与多会话', dir: '~/git/diy/diy', projectId: 'proj:diy', status: 'open' },
            members: membersOf('task'),
        },
    ];

    // 先修一遍孤儿类型：某个类型的角色被删光（手改库 / 老库迁进来的自定义类型）时，
    // 那类房间会零成员 —— 派生不出人，发消息没人应答。补一个默认角色把它救回来。
    for (const room of store.listRooms()) {
        if (membersOf(room.type).length === 0) newRole({ type: room.type, name: `${room.type} 助手` });
    }

    // 1) 落库的容器优先：运行时新建的项目/任务，重启后原样回来
    for (const room of store.listRooms()) {
        // 成员是派生的，库里的 room_members 只是历史（实体级覆盖留到以后）
        const derived = membersOf(room.type);
        const index = specs.findIndex((spec) => spec.id === room.id);
        if (index >= 0) {
            const seedSpec = specs[index]!;
            specs[index] = {
                ...seedSpec,
                ...room,
                data: { ...seedSpec.data, ...room.data },
                members: derived,
            };
        } else {
            specs.push({ ...room, members: derived });
        }
    }

    for (const spec of specs) {
        store.saveRoom(spec);
        // room_members 不是成员真源（成员是派生的），但它会被读：老库里留着「每个容器一个
        // bot」的陈旧行，指向已被合并掉的 id。启动时用派生结果盖写一遍，让这张表与派生一致。
        store.setMembers(spec.id, spec.members);
        actorOf(spec).recover();
    }
}

/**
 * 续跑所有房间的未投递消息（`RoomActor.recover()`）。
 *
 * 拆出来是因为**时机**：以前它在 `seed()` 末尾、`listen()` 之前跟着跑，于是「端口还没人
 * 能连」时三个房间的续跑已经各自 await compact() → 主请求，UI 一打开看到的就是一屏
 * 429 / 压缩日志。现在由入口在 listen 成功后调（生产 `index.ts`、dev `dev.ts`）。
 *
 * **串行**（2026-11-25）：房间一个一个续，前一个跑到收尾（`recover()` 的 Promise 在
 * 那一轮结束时 resolve）再放下一个。以前一口气全排出去，房间一多就是同一秒里十几个
 * 请求撞网关（turn 180 实测：三次启动压缩 5.8s / 6.5s / 17.3s，前两次压完仍超预算）。
 * 串行的代价是「最后一个房间要等前面都跑完」—— 但这是背景活，界面在 listen 之后
 * 就已经可用，不存在“等它才看到 UI”。
 *
 * 单个房间抛错不阻断后面：`recover()` 内部已经逐条兜住，这里再兜一层房间级的。
 */
async function resume(): Promise<void> {
    for (const [roomId, actor] of rooms) {
        try {
            await actor.recover();
        } catch (error) {
            log.warn('续跑房间失败，继续下一个', { roomId, error: (error as Error).message });
        }
    }
}

// 装配动作（seed + 草稿清理）在 `createDiy2App` 里做：顶层语句等于「import 即启动」，
// 而 import 的时机不再由本模块决定（生产入口 / dev 入口 / bin 都可能先 import）。

// ─── 工具 ─────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

/** 单条草稿上限：超了宁可拒（413）也不静默截断用户打的字 */
function tooLargeDraft(value: unknown): boolean {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > 256 * 1024;
}

/**
 * 新建一个角色。`primary` 缺省 = 「该类型还没有 primary」—— 第一个角色自动当默认应答，
 * 之后新建的都是候补（用户可以在角色页改）。
 */
function newRole(input: {
    type: string;
    name: string;
    instructions?: string;
    color?: string;
    modelKey?: string | null;
    reasoningEffort?: string | null;
    primary?: boolean;
}): BotProfile {
    const roles = store.listBotProfiles();
    const existing = roles.filter((role) => role.type === input.type);
    const now = Date.now();
    const role: BotProfile = {
        id: newEntityId(),
        type: input.type,
        name: input.name,
        color: input.color ?? COLORS[roles.length % COLORS.length]!,
        instructions: input.instructions ?? '',
        primary: input.primary ?? existing.every((entry) => !entry.primary),
        // 空串 / null 都存 null：列里只存人选过的，缺省在发送时现算（见 persistedDefaultModelKey）
        modelKey: input.modelKey === undefined || input.modelKey === '' ? null : input.modelKey,
        reasoningEffort:
            input.reasoningEffort === undefined || input.reasoningEffort === '' ? null : input.reasoningEffort,
        createdAt: now,
        updatedAt: now,
    };
    store.upsertBotProfile(role);
    return role;
}

/** 一类房间的成员名单：**派生的**，不看 room_members（见 protocol 的 membersOfType） */
function membersOf(type: string): RoomMember[] {
    return membersOfType(store.listBotProfiles(), type);
}

/**
 * 角色变了 ⇒ 该类型所有房间的成员跟着换。
 *
 * 不这么做的话，新建的角色要等进程重启才出现在房间里（成员是启动时派生的），
 * 而用户刚在角色页上点了「保存」。
 */
function refreshRoomsOf(type: string): void {
    const members = membersOf(type);
    for (const actor of rooms.values()) {
        if (actor.spec.type !== type) continue;
        if (!sameMembers(actor.spec.members, members)) actor.setMembers(members);
        // 名单没变也要推：改名 / 改人格 / 换模型都发生在成员**身上**，不是名单里
        actor.refreshIdentities();
    }
}

function sameMembers(left: readonly RoomMember[], right: readonly RoomMember[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((member, index) => {
        const other = right[index];
        return other !== undefined && member.botId === other.botId && member.primary === other.primary;
    });
}

// ─── 回包瘦身 ────────────────────────────────────────────

/**
 * `chat.history` 回包里 **tool 条目的 result 上限（字符）**。
 *
 * 2026-11-26 实测（CDP tracing + WebSocket 字节统计）：一个 6183 条的房间回包是
 * **28 MB**，其中 tool 条目占 **27.4 MB**（最长一条 9.5 MB）—— 前端 JSON.parse +
 * 渲染要 **2.9~3.3 秒**，每次切房间都重来；tracing 里就是一个匿名函数连跑 2.9s，
 * 用户点输入框得给它让路（“点输入框几秒钟”）。
 *
 * 工具输出是**过程**：时间线上看的是“跑了什么、成不成、大概什么结果”，
 * 不需要把 9.5MB 的 stdout 发到浏览器。完整原文仍在库里（`toolout/` + items），
 * 要全文从服务端取 —— 截断处会写明原文多少字，不假装这就是全部。
 *
 * **体积是「条数 × 阈值 × 编码开销」**（同日三改，每改一次都实测）：
 *   2000 字 × 5404 条 ≈ 10.7MB  → longtask 仍 2.7s
 *    400 字 × 5404 条 ≈  6.8MB  → longtask 1.9s（中文 UTF-8 是 3 字节/字，400「字符」
 *                                 在 JSON 里约 1.2KB，乘 5404 条就是 6.5MB）
 *    120 字 × 5404 条 ≈  2.0MB  → 目标
 * 一路降到 120：这里要的是「这条命令干了什么、结果开头什么样」，不是输出全文。
 * 原文一直在库里，点开看全文那件事该由一条**单独取**的接口承担，不该塞进历史回包。
 *
 * 只裁 **history 这一条路**（侧栏 / `bots.rows` 不碰它）。
 */
const HISTORY_TOOL_RESULT_CHARS = 120;

/**
 * 把历史里的超大 tool 结果裁到 `HISTORY_TOOL_RESULT_CHARS`（不改变其他条目）。
 * 导出只为了能被单测钉住（它是回包体积的唯一闸门）。
 */
export function trimToolResults(items: Item[]): Item[] {
    return items.map((item) => {
        if (item.type !== 'tool') return item;
        const result = item.data.result;
        if (typeof result !== 'string' || result.length <= HISTORY_TOOL_RESULT_CHARS) return item;
        return {
            ...item,
            data: {
                ...item.data,
                result: `${result.slice(0, HISTORY_TOOL_RESULT_CHARS)}\n\n…（历史里只带前 ${HISTORY_TOOL_RESULT_CHARS} 字，原文 ${result.length} 字）`,
            },
        };
    });
}

// ─── 路由 ─────────────────────────────────────────────────────────

/**
 * 聊天历史**默认只发最近的这么多条**（2026-11-26）。
 *
 * 数字来源：实测每条约 1 KB（裁过 tool 结果后），6000 条的房间里 5.7 MB 的回包会让
 * 主线程一次性 parse + 渲染 2~5 秒。400 条 ≈ 400 KB，能盖住“打开就看到最近发生了什么”。
 */
const HISTORY_LIMIT = 400;

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
        // GET /api/info —— 实例自报身份（探活判据：`app` + `home`）。端口/pid 都是缓存，
        // 「谁在监听这个端口、用哪个数据根」只有监听者自己答得准（仓库 ##328 同一现场）。
        if (req.method === 'GET' && url.pathname === '/api/info') {
            json(res, 200, info());
            return;
        }

        // 迁移闸门的探针：真 app 直接答「不用迁了」。
        // 回 404 会让浏览器控制台多两条红字 —— UI 里「console 零错误」是硬规矩，
        // 而且探针本来是正常流程的一环，不是「找不到」。
        if (req.method === 'GET' && url.pathname === '/api/migrate/state') {
            json(res, 200, { mode: 'ready' });
            return;
        }

        // GET /api/metrics —— 事件循环延迟快照（2026-11-26：页面慢时先看这里）。
        // 为什么单独一个端点而不是塞进 /api/info：探活每几秒打一次 info，
        // 而 lag 是排障用的低频读，混进去只会让探活回包变大。
        if (req.method === 'GET' && url.pathname === '/api/metrics') {
            json(res, 200, { lag: lagMonitor?.snapshot() ?? null });
            return;
        }

        // 静态资源 / SPA 路由：/api 之外的 GET 交给 UI 产物
        if (req.method === 'GET' && !url.pathname.startsWith('/api') && serveStatic !== undefined) {
            if (await serveStatic(url.pathname, res)) return;
        }

        json(res, 404, { error: `unknown ${req.method ?? '?'} ${url.pathname}` });
    } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
};

// ─── 装配入口（唯一） ──────────────────────────────────────────────

/** `/api/info` 的回包；`port` 为 null = 还没监听（dev 的 SSR 预装配阶段） */
export interface Diy2AppInfo {
    app: typeof APP_ID;
    pid: number;
    port: number | null;
    home: string;
    env: string;
    /** 入口名（老字段名 variant 仍然保留给读者，值 = launch） */
    variant: string;
    launch: string | null;
    name: string | null;
    tools: 'shell' | 'files';
}

export interface Diy2App {
    /** 静态资源要 await 磁盘，所以是 Promise —— 错误已在内部 try/catch 收掉，不会 reject */
    handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    /**
     * 续跑：把各房间没投递完的消息重新点着（`recover()`）。
     *
     * **必须在监听之后调**（##554 后续）：它一调就会发 LLM 请求，而在监听之前点火等于
     * 「UI 还没人能连上，模型配额已经开始烧」—— 启动顺序里最贵的这一步不该抢在门打开之前。
     */
    /** 串行续跑所有房间（拿到 Promise 是为了测试 / 优雅关闭能等它）；入口不必 await */
    resume: () => Promise<void>;
    /**
     * 处理一条 HTTP upgrade（`/rpc` 归这里，返回 true；其余返回 false 交给别人 ——
     * dev 里 vite 的 HMR 也走 upgrade 通道，**不要动不是自己的 socket**）。
     */
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
    /** 当前 WS 连接与它们正在订阅的房间（dev app / 排查用） */
    rpcStreams: () => RpcStreamInfo[];
    info: () => Diy2AppInfo;
    /** 关闭所有 SSE / WS 订阅（进程退出 / dev 重启前调用；sqlite 由进程退出收尾） */
    close: () => void;
}

/*
 * 「某个成员上一轮的结局」查询器已移到 `@diy-agent/entity-runtime` 的 `createTurnLookup`
 * （`rooms.list` 与 `bots.rows` 共用一份，判据在 `bot-status.ts`）。
 */

/**
 * 装配一个 diy2 应用（**不监听端口**）。
 *
 * @param opts.config 运行配置（`./config` 的唯一真源）
 * @param opts.webDir 静态服务目录：`null` = 明确不要（dev 交给 vite）；`undefined` = 用 config 的
 * @param opts.port   实际监听端口（`() => server.address().port`；dev 单端口时由调用方给）
 */
export async function createDiy2App(opts: {
    config: Diy2Config;
    webDir?: string | null | undefined;
    port?: () => number | null;
}): Promise<Diy2App> {
    config = opts.config;
    // null 与 undefined 是两件事：null = 「我明确不要静态服务」（dev 的页面来自 vite），
    // undefined = 「按配置来」（生产）。写成 `??` 会让 dev 在 build/prod/web 存在时**悄悄**
    // 拿到上一轮的旧壳子 —— 那种 bug 只能靠肉眼分辨「为什么改了 UI 没变」。
    serveStatic = await createStaticHandler(opts.webDir === null ? undefined : (opts.webDir ?? config.webDir));
    // 事件循环延迟监控（./loop-lag）：从装配开始记，`/api/metrics` 读快照。
    // 重复装配（测试 / dev 重建）先把上一个停掉，不然会留两个采样器。
    // 日志出口走 appLog（本进程不直接碰 console，见 ./log）。
    lagMonitor?.stop();
    lagMonitor = startLoopLag({ log: (line) => log.warn(line) });
    configureSlowLog((line) => log.warn(line));
    rooms = new Map();
    subscribers = new Map();
    activitySinks = new Set();
    lastActivityKey = '';

    await mkdir(config.home, { recursive: true });
    store = openStore(config.dbPath);
    /**
     * 「某个成员上一轮的结局」查询器 —— **全进程一份、带 5s 缓存**（2026-11-26）。
     *
     * `rooms.list` 与 `bots.rows` 每隔 1.5~6 秒都要这一份数据，每次重建要跑两条全表
     * json 分组（实测 529ms + 39ms）；三个 agent 在跑时它们几乎不停地跑，同连接的
     * 其他请求（chat.load / 点击后的 RPC）只能排队。缓存的理由与 TTL 取舍见
     * `createCachedTurnLookup` 的注释。
     */
    const lookupTurn = createCachedTurnLookup(store);
    /** 打点包一层：命中缓存是 Map 查（不报），未命中的那 529ms 会在日志里指名 `turnLookup` */
    const turnOf = (roomId: string, botId: string) => timed('turnLookup', () => lookupTurn(roomId, botId));

    // 作业账本要在 `seed()` / 首个房间之前建好：`actorOf` 装配工具时要用它。
    // 根目录 `<home>/log/job/runs`：与其余运行产物同根，清 home 就清干净。
    jobs = createJobRegistry({
        rootDir: join(config.home, 'log', 'job', 'runs'),
        // 作业起停也要推活动：作业不属于任何房间流，标题栏那颗「作业 N」靠它亮
        onChange: () => broadcastActivity(),
        // 房间已删 / 成员已退 → 回报 false：账本把结局记成 `delivered:false`（盘上 `done.json`
        // 的 `notified:false`），全局面板据此标「结局无人接」。用 `?.` 静默丢弃等于让这条活跑完
        // 之后没人知道 —— 那正是用户报的「逃逸」之一。
        onDone: (event, owner) => {
            const actor = rooms.get(owner.roomId);
            if (actor === undefined) {
                console.warn(`[job] 结束通知无人接：房间 ${owner.roomId} 已不存在（run ${event.run.id}）`);
                return false;
            }
            return actor.notifyJobDone(owner, event);
        },
    });

    seed();

    // 对话框草稿的 owner 是 synthetic scope（`dlg:<用途>:<roomId>`）：删项目时已级联，
    // 剩下的（用户再也不打开那个对话框 / 房间 id 早就换掉）靠 TTL 收，别让库只增不减。
    const prunedDialogs = store.pruneDraftOwners('dlg:', Date.now() - DIALOG_DRAFT_TTL);
    if (prunedDialogs > 0) log.info('清掉过期对话框草稿', { count: prunedDialogs });

    /**
     * diy2 的**命令面**（RPC）：浏览器侧唯一的 API（REST 已删，只剩 `/api/info` 探活）。
     *
     * handler 直接复用路由里的同一套领域操作，不再经过 req/res —— 错误用异常表达，
     * 由 rpc 传输层转成错误帧（HTTP 那边是 4xx/5xx）。
     */
    type Diy2Handlers = HandlersOf<typeof diy2Api>;

    /**
     * 附件库（懒建一次）：`<home>/blobs`。
     *
     * 与 entity-runtime 里 `defaultAttachmentReader` 写的是同一个路径 —— 上传落这里、
     * 模型侧从这里读。分叉过一次就等着「能上传但模型看不着」那种怪事。
     */
    let blobStore: ReturnType<typeof createBlobStore> | null = null;
    const blobs = (): ReturnType<typeof createBlobStore> => {
        blobStore ??= createBlobStore({ root: join(config.home, 'blobs') });
        return blobStore;
    };

    const bindDiy2Api = (server: ChannelServerBinding): void => {
        const handlers: Diy2Handlers = {
            info: async () => info(),
            rooms: {
                list: async () => {
                    // 打点：这三条是侧栏每次刷新都要跑的同步 SQL（实测冷库里 lastItemPerBot
                    // 529ms、其余几十 ms），卡住时日志里必须看得见是谁（./loop-lag）
                    const draftOwners = store.draftOwnersByKind();
                    const withInputDraft = new Set(draftOwners.input);
                    const lastItemAt = timed('rooms.list.lastItemAtByRoom', () => store.lastItemAtByRoom());
                    // 未读：一次算完全实例（一条 GROUP BY），不逐房间问
                    const unread = timed('rooms.list.unreadByRoom', () => store.unreadByRoom());
                    // 未送达：同样一次算完全实例。按 (房间, bot) 收敛到各自最新一条投递，
                    // 历史 failed 不永久占位（旧消息失败、后来新消息送达就算过去了）。
                    const failedByRoom = timed('rooms.list.failedByRoom', () => store.failedByRoom());
                    // 「上一轮出错的成员」：侧栏图标要变红（用户 2026-11-26：表格说「出错」而侧栏
                    // 图标没变，两处不一致）。数据与 `bots.rows` 同源（`turnLookupOf`），不各算一份。
                    // 打点包住**取数**那一下：命中缓存时是个 Map 查（<1ms），未命中才是 529ms
                    return [...rooms.values()].map((actor) => {
                        const id = actor.spec.id;
                        const at = lastItemAt[id];
                        const pendingRequests = actor.pendingAskRequests();
                        const pendingAsks = pendingRequests.length;
                        // 在跑成员数：与全局活动帧同源（`runningBots`），这里只是「列表里顺带一份」，
                        // 给那些还没建活动流的老客户端一个初值
                        const runningBots = actor.runningBots();
                        const running = runningBots.length;
                        // 上一轮结局不是 done 的成员数 —— **不排除在跑的**（用户 2026-11-26 原话：
                        // “表格说「出错」，左侧导航栏的任务图标也应该变状态”）。
                        // 之前排除在跑的理由是“它此刻正在挣扎”，但那样恰好把最该看见的情况
                        // （上轮被中断、这轮在重试）藏掉了：表格里写着「上轮 · 中断」，图标却什么都不说。
                        // 两件事本来就能并存 —— 红图标 = 上一轮有问题，绿点 = 此刻在跑。
                        let broken = 0;
                        for (const member of actor.spec.members) {
                            const turn = turnOf(id, member.botId);
                            if (turn !== undefined && turn.outcome !== 'done') broken += 1;
                        }
                        // 排队中的投递（含重启后的待续跑）：以前列表里没有这个数，
                        // 于是房间「看着没事、其实排着队」或「明明在干、只是还没轮到它」都看不见
                        const queued = [...actor.queuedByBot().values()].reduce((sum, n) => sum + n, 0);
                        const failed = failedByRoom[id] ?? 0;
                        return {
                            ...actor.spec,
                            hasDraft: withInputDraft.has(id),
                            ...(running === 0 ? {} : { running }),
                            ...(queued === 0 ? {} : { queued }),
                            ...(pendingAsks === 0 ? {} : { pendingAsks }),
                            // 带题干：侧栏 ? 的 tooltip 要说清「问的是什么」，只说个数进房间还得自己翻
                            ...(pendingAsks === 0
                                ? {}
                                : {
                                      pendingAskTitles: pendingRequests.map(
                                          (request) => request.questions[0]?.question ?? '',
                                      ),
                                  }),
                            ...(at === undefined ? {} : { lastActivityAt: at }),
                            ...((unread[id] ?? 0) === 0 ? {} : { unread: unread[id] }),
                            ...(broken === 0 ? {} : { broken }),
                            ...(failed === 0 ? {} : { failed }),
                        };
                    });
                },
                create: async ({ input }) => {
                    const type = input.type ?? 'project';
                    const projectId = input.data?.['projectId'];
                    if (type === 'task' && (typeof projectId !== 'string' || roomOf(projectId) === undefined)) {
                        throw new Error('task 需要有效的 data.projectId');
                    }
                    const id = newEntityId();
                    // 成员是从角色表**派生**的：新任务建出来就自动有「任务助手」这类角色。
                    // 类型是开放字符串，第一次见到某个类型时补一个默认角色 —— 否则新房间
                    // 零成员，发消息没人应答，用户还得先去角色页建人。
                    if (membersOf(type).length === 0) newRole({ type, name: `${type} 助手` });
                    const spec: Room = {
                        id,
                        type,
                        // 容器名跟着容器走：任务的标题 / 项目的名字都在 data 里
                        data:
                            type === 'task'
                                ? { status: 'open', title: input.name, ...input.data }
                                : { name: input.name, ...input.data },
                        members: membersOf(type),
                    };
                    store.setMembers(id, spec.members);
                    actorOf(spec);
                    return store.listRooms().find((room) => room.id === id) ?? spec;
                },
                update: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    // 容器的名字落在自己的键上：任务叫 title，项目叫 name
                    const namePatch =
                        input.name === undefined ? {} : { [actor.spec.type === 'task' ? 'title' : 'name']: input.name };
                    actor.update({
                        ...(input.name === undefined && input.data === undefined
                            ? {}
                            : { data: { ...namePatch, ...input.data } }),
                    });
                    return actor.spec;
                },
                remove: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const victims =
                        actor.spec.type === 'project'
                            ? [
                                  input.id,
                                  ...[...rooms.values()]
                                      .filter((entry) => entry.spec.data['projectId'] === input.id)
                                      .map((entry) => entry.spec.id),
                              ]
                            : [input.id];
                    for (const roomId of victims) {
                        rooms.get(roomId)?.stop();
                        rooms.delete(roomId);
                        store.deleteRoom(roomId);
                        broadcast(roomId, { kind: 'done' });
                    }
                    return { id: input.id, deleted: victims };
                },
                /**
                 * 上报未读水位（房间打开且页面可见时由 UI 调）。
                 * 只前进不后退 —— 多个标签页 / 迟到的旧上报不能把水位拉回去。
                 */
                markRead: async ({ input }) => {
                    store.markRead(input.id, input.seq);
                    return { ok: true, seq: store.readSeqOf(input.id) ?? input.seq };
                },
            },
            botProfiles: {
                list: async () => store.listBotProfiles(),
                create: async ({ input }) => {
                    const type = input.type.trim();
                    const name = input.name.trim();
                    if (type === '') throw new Error('type required');
                    if (name === '') throw new Error('name required');
                    // 同类型重名 = 界面上的两行分不清（@ 补全按名字选人）
                    if (store.listBotProfiles().some((role) => role.type === type && role.name === name)) {
                        throw new Error(`「${type}」已经有叫「${name}」的角色`);
                    }
                    const role = newRole({ ...input, type, name });
                    refreshRoomsOf(role.type);
                    return role;
                },
                update: async ({ input }) => {
                    const role = store.listBotProfiles().find((entry) => entry.id === input.id);
                    if (role === undefined) throw new Error(`角色不存在：${input.id}`);
                    const name = input.name === undefined ? role.name : input.name.trim();
                    if (name === '') throw new Error('name required');
                    const next: BotProfile = {
                        ...role,
                        name,
                        ...(input.color === undefined ? {} : { color: input.color }),
                        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
                        // null 与空串同义：列里只存人选过的，缺省在发送时现算
                        ...(input.modelKey === undefined
                            ? {}
                            : { modelKey: input.modelKey === '' ? null : input.modelKey }),
                        ...(input.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: input.reasoningEffort === '' ? null : input.reasoningEffort }),
                        ...(input.primary === undefined ? {} : { primary: input.primary }),
                        updatedAt: Date.now(),
                    };
                    store.upsertBotProfile(next);
                    refreshRoomsOf(next.type);
                    return next;
                },
                remove: async ({ input }) => {
                    const role = store.listBotProfiles().find((entry) => entry.id === input.id);
                    if (role === undefined) return { ok: true };
                    // 每类至少留一个：成员是派生的，没有「再加入房间」这回事，
                    // 删光了那类房间就永远没人应答（只能去角色页重建 + 重启才能回到房间）
                    if (store.listBotProfiles().filter((entry) => entry.type === role.type).length <= 1) {
                        throw new Error(`「${role.type}」只剩这一个角色，删了那类房间就没人应答`);
                    }
                    store.deleteBotProfile(role.id);
                    refreshRoomsOf(role.type);
                    return { ok: true };
                },
                config: {
                    list: async () => store.listBotProfileDefaults(),
                    set: async ({ input }) => {
                        const config: BotProfileDefaults = {
                            type: input.type.trim(),
                            modelKey: input.modelKey === undefined || input.modelKey === '' ? null : input.modelKey,
                            reasoningEffort:
                                input.reasoningEffort === undefined || input.reasoningEffort === ''
                                    ? null
                                    : input.reasoningEffort,
                            updatedAt: Date.now(),
                        };
                        store.setBotProfileDefaults(config);
                        refreshRoomsOf(config.type);
                        return config;
                    },
                },
            },
            chat: {
                history: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    // 分页（2026-11-26）：实测一次回包 **5.7 MB**（6000+ 条 items）——
                    // 前端 JSON.parse + 渲染就是那 2~5 秒的长任务（用户“切任务很慢”）。
                    // 默认只发**最近的 HISTORY_LIMIT 条**；`limit<=0` = 全量（用户点“加载更早”）。
                    // `total`/`hasMore` 让界面能说清“上面还有多少条没加载”。
                    const limit = input.limit ?? HISTORY_LIMIT;
                    const items = limit > 0 ? actor.lastItems(limit) : actor.items(0);
                    const total = limit > 0 ? actor.countItems() : items.length;
                    return {
                        items: trimToolResults(items),
                        total,
                        hasMore: items.length < total,
                        deliveries: actor.deliveries(),
                        asks: actor.pendingAskRequests(),
                        answered: actor.answeredAskRequests(),
                        // 服务端事实：谁还在跑。取房间自己的 `running` 集合（与广播同源），
                        // 客户端不再靠「有没有流式条目」倒推 —— 卡在等上游的那一轮没有流式条目。
                        speaking: actor.runningBots(),
                        // 在跑的那几轮从何时开始：刷新后消息头 / 「已用 Ns」靠它，
                        // 不能由客户端拿条目时刻去估（收轮时会跟 turn.end 给的 startedAt 跳一下）
                        runningTurns: actor.runningTurns(),
                    };
                },
                wait: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const sinceSeq = input.sinceSeq ?? 0;
                    // 10s：要明显小于 run_code 的 30s 预算（见 protocol 里那条注释）
                    const deadline = Date.now() + (input.timeoutMs ?? 10_000);
                    // 轮询间隔：本地 sqlite 读一条 eq 读 200 次/秒不痛；再密就是给自己找 IO
                    const POLL_MS = 200;
                    for (;;) {
                        const fresh = actor.items(sinceSeq);
                        if (fresh.length > 0) {
                            // 只回最近 50 条：长轮询是「醒来看看」，不是拉全量（拉全量是 history 的事）
                            const tail = fresh.slice(-50);
                            return { timedOut: false, seq: tail[tail.length - 1]?.seq ?? sinceSeq, items: tail };
                        }
                        if (Date.now() >= deadline) return { timedOut: true, seq: sinceSeq, items: [] };
                        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
                    }
                },
                chat: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const text = input.text.trim();
                    // 附件在 zod 层已验过形状；这里再走一遍真源校验（防“zod 宽了、ref 却不对”）
                    // —— 网络边界上是最后一道，宁可炸在发消息时，也不要存进 db 后才发现。
                    const attachments =
                        input.attachments === undefined
                            ? []
                            : parseAttachmentRefs(input.attachments, 'chat.attachments');
                    if (text === '' && attachments.length === 0) throw new Error('text or attachments required');
                    void actor.say({ text, author: HUMAN, attachments }).catch((error: unknown) => {
                        broadcast(input.id, {
                            kind: 'error',
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });
                    return { ok: true };
                },
                cancel: async ({ input }) => {
                    requireRoom(input.id).cancel({
                        keepQueue: input.keepQueue === true,
                        ...(input.botId === undefined ? {} : { botId: input.botId }),
                    });
                    return { ok: true };
                },
                sessions: async ({ input }) => ({ sessions: requireRoom(input.id).sessionsInfo() }),
                /**
                 * **受理即返**（与 `chat.chat` 同一个口径）。
                 *
                 * 压缩的进展靠 `compact` 事件回推：它要等好几秒的 LLM 摘要，挂到 RPC 返回上
                 * 等于用户点完只能盯一个禁用的按钮（2026-11-25 实测就是这个体验）。
                 * 先返回 compactId，客户端立刻就能显示「摘要中…」并能按 id 取消；
                 * 失败走 `error` 广播，跟发消息那条路一样。
                 */
                compact: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const compactId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                    // 面板上的「保留最近几轮」是真参数，别用空对象盖掉（否则手动压缩永远按常量压）
                    void actor
                        .compact(input.botId, {
                            compactId,
                            ...(typeof input.keepTurns === 'number' ? { keepTurns: input.keepTurns } : {}),
                        })
                        .catch((error: unknown) => {
                            // 正在压缩 / bot 不在房间里：让用户看得见，不能静默
                            broadcast(input.id, {
                                kind: 'error',
                                message: error instanceof Error ? error.message : String(error),
                            });
                        });
                    return { compactId };
                },
                cancelCompact: async ({ input }) => {
                    // 已经跑完 / 不认识的 id → false（手点慢而己，不是错误）
                    return { ok: requireRoom(input.id).cancelCompact(input.compactId) };
                },
            },
            asks: {
                list: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    return { asks: actor.pendingAskRequests(), answered: actor.answeredAskRequests() };
                },
                answer: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    const outcome = actor.answerAsk(input.askId, input.answer as AskAnswer);
                    if (outcome.ok) return { ok: true };
                    throw new Error(outcome.code === 'bad-answer' ? outcome.reason : 'no such pending ask');
                },
                cancel: async ({ input }) => {
                    const actor = requireRoom(input.id);
                    if (!actor.cancelAsk(input.askId)) throw new Error('no such pending ask');
                    return { ok: true, pending: actor.pendingAsks() };
                },
            },
            drafts: {
                list: async ({ input }) => ({ drafts: store.listDrafts(input.owner) }),
                put: async ({ input }) => {
                    if (tooLargeDraft(input.value)) throw new Error('draft too large (max 256KB)');
                    return { updatedAt: store.putDraft(input.owner, input.field, input.value)?.updatedAt ?? 0 };
                },
                remove: async ({ input }) => {
                    store.deleteDraft(input.owner, input.field);
                    return { ok: true };
                },
            },
            journal: {
                list: async ({ input }) => ({ entries: store.journalOf(input.id, input.limit ?? 50) }),
            },
            /**
             * 模型目录（选模型器 / 新建房间的缺省值）。
             *
             * 真源是 `model.yaml`（`@diy-agent/model-catalog`），**不经过界面里的表**：界面原来自带
             * 一份 `PROVIDERS`（端点 / 价目 / 上下文窗口），与真配置各自演进 —— 「界面上能选、
             * 服务端发不出去」就是这么来的。回包永不含 key 值（账号只有名字与填没填）。
             */
            models: {
                // `configured` / `snapshotMissing` 不是兼容字段，是**状态**：没有 model.yaml 的
                // 实例是一个明确形态（模型面不可用），界面顶部据此挂横幅 —— 不靠「目录恰好是空的」去猜。
                list: async () => ({
                    providers: modelProviders(),
                    defaultModelKey: defaultModelKeyOf(),
                    configured: existsSync(config.modelConfigPath), // sync-io-ok: 模型配置状态自报，只判文件存在与否；与启动期 modelConfigHint 同源
                    modelConfigPath: config.modelConfigPath,
                    snapshotMissing: !existsSync(snapshotPath(config.home)), // sync-io-ok: 同上，判断目录快照在不在
                }),
                // ── 配置页（写侧）──────────────────────────────────────────
                //
                // 每个写方法都回一整页新快照：界面不必自己拼第二份状态，也就不会出现
                // 「服务端已经改了、界面上还是老的」这种最难解释的情形。
                config: async () => modelConfigView(),
                saveProvider: async ({ input }) => {
                    const args = argsOf(input);
                    const kind = args['kind'];
                    if (kind !== undefined && kind !== 'std' && kind !== 'custom') {
                        throw new Error('kind 只能是 std / custom');
                    }
                    writeProvider(config.home, {
                        providerId: textArg(args, 'providerId'),
                        ...(kind === undefined ? {} : { kind }),
                        ...(args['spec'] === undefined
                            ? {}
                            : { spec: args['spec'] as { id?: string; npm?: string; api?: string } }),
                        ...(args['models'] === undefined
                            ? {}
                            : { models: args['models'] as Record<string, never> }),
                        ...(args['filter'] === undefined
                            ? {}
                            : {
                                  filter: args['filter'] as {
                                      include?: readonly string[] | null;
                                      exclude?: readonly string[] | null;
                                  },
                              }),
                    });
                    return modelConfigView();
                },
                removeProvider: async ({ input }) => {
                    dropProvider(config.home, textArg(argsOf(input), 'providerId'));
                    return modelConfigView();
                },
                saveAccount: async ({ input }) => {
                    const args = argsOf(input);
                    const kind = args['kind'];
                    if (kind !== undefined && kind !== 'std' && kind !== 'custom') {
                        throw new Error('kind 只能是 std / custom');
                    }
                    const saved = writeAccount(config.home, {
                        providerId: textArg(args, 'providerId'),
                        name: textArg(args, 'name'),
                        value: textArg(args, 'value'),
                        ...(kind === undefined ? {} : { kind }),
                    });
                    // 只有长度：key 值到此为止（catalog 的硬边界，这里不越）
                    return {
                        config: modelConfigView(),
                        saved: { providerId: saved.providerId, name: saved.name, chars: saved.chars },
                    };
                },
                renameAccount: async ({ input }) => {
                    const args = argsOf(input);
                    relabelAccount(config.home, textArg(args, 'providerId'), textArg(args, 'from'), textArg(args, 'to'));
                    return modelConfigView();
                },
                removeAccount: async ({ input }) => {
                    const args = argsOf(input);
                    dropAccount(config.home, textArg(args, 'providerId'), textArg(args, 'name'));
                    return modelConfigView();
                },
                saveDefaultModel: async ({ input }) => {
                    const modelKey = argsOf(input)['modelKey'];
                    if (modelKey !== null && typeof modelKey !== 'string') {
                        throw new Error('modelKey 必须是字符串或 null');
                    }
                    writeDefaultModel(config.home, modelKey);
                    return modelConfigView();
                },
            },
            /**
             * 任务的**需求账本树**（只读）。writer 只有 agent 的 `unit_*` 工具，
             * 界面是旁观者的窗口 —— 想改就在聊天里说。推导在 `unitBoard`（同一份纯函数）。
             */
            units: {
                /**
                 * 一条需求的**全貌**：需求本身 + 步骤 + 挂在它上面的决策/其它日志。
                 *
                 * 为什么按需取而不是 list 一次给全（2026-11-27）：目标页首屏只要需求层，
                 * 步骤与决策只在点开某条时才看 —— 一次全给等于每 5 秒轮询几百条详情。
                 */
                get: async ({ input }) => {
                    const units = store.listUnits(input.id);
                    const board = unitBoard(units);
                    const row = board.rows.find((item) => item.id === input.unit);
                    if (row === undefined) throw new Error(`没有这条需求：${input.unit}`);
                    const quotes = sourceQuotesOf(store.itemsByIds([row.source]));
                    const [withQuote] = withSourceQuotes({ ...board, rows: [row] }, quotes).rows;
                    // 决策 / 其它日志：journal 上是 append-only 的，按 unit 过滤就是这条需求的决策清单
                    const journal = store.journalOf(input.id, 400).filter((entry) => entry.unit === input.unit);
                    return {
                        need: withQuote ?? row,
                        decisions: journal.filter((entry) => entry.kind === 'decision'),
                        notes: journal.filter((entry) => entry.kind !== 'decision'),
                    };
                },
                list: async ({ input }) => {
                    const board = unitBoard(store.listUnits(input.id));
                    // 「来自哪句话」要能当场核对：光有 message id，人还得自己点进去看是谁说的。
                    // 所以这里把 source 解开成「发言人 + 原话」贴上（纯函数 `withSourceQuotes`），
                    // 解不开的（消息已剪 / 老数据 / 非人类触发）就**不贴** —— 不知道比编一个强。
                    const ids = board.rows.map((row) => row.source).filter((id) => id !== '');
                    return withSourceQuotes(board, sourceQuotesOf(store.itemsByIds(ids)));
                },
                /**
                 * 模型读到的 `units` 节原文。
                 *
                 * 与上下文注入**同一份代码**（`unitsContextText()`）：界面若自己再拼一遍文本，
                 * 两边迟早在溢出退化 / 哪些条目点名上分叉，而人看这一页恰恰是在核对
                 * 「模型到底读到了什么」。
                 */
                text: async ({ input }) => unitsContextText(unitBoard(store.listUnits(input.id))),
            },
            links: {
                list: async ({ input }) => {
                    const links = store.linksOf(input.id);
                    return {
                        out: links.out.map((link) => ({ id: link.to, kind: link.kind, ...labelOf(link.to) })),
                        in: links.in.map((link) => ({ id: link.from, kind: link.kind, ...labelOf(link.from) })),
                    };
                },
                add: async ({ input }) => {
                    store.link(input.id, input.to, input.kind ?? 'related');
                    return { ok: true };
                },
                remove: async ({ input }) => ({ removed: store.unlink(input.id, input.to, input.kind) }),
            },
            /**
             * run 表的**只读投影** + 停一个。
             *
             * 与 agent 的 `job list` / `job kill` 同一份账本、同一套语义（`visible` 在这里是
             * 全部：一个实例一张表，界面看的就是这张表）。时长按**现在**算 —— 界面上那个
             * 秒表要跳，不能等下一次 `job status` 回来才知道过去了多久。
             */
            /**
             * 附件：字节进（粘贴 / 拖拽 → blobs）/ 字节出（界面显示缩略图）。
             *
             * blobs 根与 room 的附件读法**同一个约定**（`<home>/blobs`，见 entity-runtime 的
             * `defaultAttachmentReader`）—— 上传落一份、模型侧读同一份，不复制真相。
             */
            attachment: {
                put: async ({ input }) => {
                    const bytes = Buffer.from(input.base64, 'base64');
                    if (bytes.byteLength === 0) throw new Error('附件内容为空');
                    return blobs().putBytes({
                        bytes,
                        source: input.source ?? 'paste',
                        ...(input.name === undefined ? {} : { name: input.name }),
                        ...(input.mime === undefined ? {} : { mime: input.mime }),
                    });
                },
                get: async ({ input }) => {
                    const ref = parseAttachmentRef(input.ref, 'attachment.get');
                    const bytes = ref.type === 'stored' ? await blobs().read(ref) : await readFile(ref.path);
                    return { base64: Buffer.from(bytes).toString('base64'), mime: ref.mime };
                },
            },
            jobs: {
                list: async () => ({ rows: jobs.list().map(jobRowOf) }),
                kill: async ({ input }) => ({ ok: jobs.kill(input.id) }),
                /** 输出尾巴：与 agent 的 `job output` 同一个 `registry.tail`（同一套截断 / 去色） */
                tail: async ({ input }) => {
                    const tail = await jobs.tail(input.id, input.lines ?? 40);
                    return tail === undefined ? { found: false } : { found: true, tail };
                },
            },
        };
        server.use({ prefix: 'diy2', api: diy2Api, handlers });
    };

    // ── 进程内的第二份命令面：给 `run_code` 用 ──
    // 为什么再绑一份而不是让模型自己拼 `createMemTransportPair`：
    //   · 调用方（模型代码）只该看到 `api.bots.update({…})` 这种强类型调用；
    //   · 换引擎（进程内 vm → worker / 子进程）时改的是这里传什么 client，模型代码不动。
    // 为什么走 mem 而不是裸调 handler：零序列化的好处拿到了，zod 校验与契约仍然生效。
    {
        const mem = createMemTransportPair();
        bindDiy2Api(new ChannelServerBinding(mem.serverTx));
        codeHost = {
            runtime: defaultCodeRuntime,
            api: createTypedClient(new ChannelClientBinding(mem.clientTx), diy2Api, { prefix: 'diy2' }),
            // 前缀 `diy2` 会从 path 里剥掉：模型看到的是 `api.bots.list`，照抄才对得上
            // descOf：每个方法的用途在 protocol 包那张表里（38 条并排才看得出撞车/可合并），
            // 不写在各处 `RpcSchema.unary({desc})` —— 模型读 apiHelp 是为了判断该不该用
            apiHelp: apiHelpOf(diy2Api, { prefix: 'diy2', descOf: (path) => METHOD_DESC[path] }),
        };
    }

    // RPC 面：事件流（WS）+ 命令面。与 SSE 并存一段时间 —— 客户端切过去、验证稳定后再删 SSE。
    const rpc = createRpcSocket({
        attach,
        attachActivity,
        hasRoom: (roomId) => roomOf(roomId) !== undefined,
        bind: bindDiy2Api,
    });

    info = (): Diy2AppInfo => ({
        app: APP_ID,
        pid: process.pid,
        port: opts.port?.() ?? (config.port === 0 ? null : config.port),
        home: config.home,
        env: config.env,
        // `variant` 是老字段（读者还在用它）：现在 = 入口名（launch），两者不再各算一遍
        variant: config.launch,
        launch: config.launch,
        name: config.name,
        tools: config.tools,
    });

    const close = (): void => {
        lagMonitor?.stop();
        lagMonitor = undefined;
        rpc.close();
        subscribers.clear();
        activitySinks.clear();
    };

    return { handle, resume, handleUpgrade: rpc.handleUpgrade, rpcStreams: rpc.streams, info, close };
}

/**
 * personaStore — agent 人物与模型的**只读清单** + 换绑动作（renderer 侧唯一入口）
 *
 * 为什么单独一个 store（而不是塞在 localChatStore 里）：
 *   persona 是**任务属性**（详情面板要选、会话页也要显示、试验场要用），
 *   而 localChatStore 管的是"某个任务的会话流"。会话页只是使用者之一，
 *   把它俩耦合会导致"打开详情面板时清单还没加载"这种时序 bug。
 *
 * 真源在 main（$DIY_HOME/personas.yaml + 任务 frontmatter 的 persona），
 * 本 store 只做缓存与展示映射：清单丢了/加载失败都不影响对话（main 侧自己会解析）。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { editTask } from "../lib/task-edit";
import { taskStore } from "./taskStore";
import { notificationStore } from "./notificationStore";
import type { PersonaView } from "../../shared/persona";
import type { ReasoningEffort } from "../../shared/models";

/** 模型清单里本 store 用到的最小形状（展示用：id → 名字 / 推理档位支持集） */
interface ModelBrief {
    /** 完全限定名 account@provider/model —— persona.model 存的就是它 */
    ref: string;
    id: string;
    name: string;
    reasoning: { supported: ReasoningEffort[]; default: ReasoningEffort };
}

/** 按限定名 `ref`（或裸 id，兼容存量）在清单里找条目 */
function findModelBrief(refOrId: string): ModelBrief | undefined {
    return models().find((m) => m.ref === refOrId) ?? models().find((m) => m.id === refOrId);
}

const [personas, setPersonas] = createSignal<PersonaView[]>([]);
const [defaultPersona, setDefaultPersona] = createSignal<string>("");
/** 跟随缺省的任务数（改缺省会影响它们；不计入任何人的 taskCount，见 main 侧 list） */
const [followCount, setFollowCount] = createSignal(0);
const [models, setModels] = createSignal<ModelBrief[]>([]);
let loading: Promise<void> | null = null;
/** 是否有一次 load 在途（面板据此显示"加载中…"，并避免在清单到达前做选中校准） */
const [busy, setBusy] = createSignal(false);

/** 加载清单（幂等 + 并发去重）。失败不抛：清单非关键路径，下次调用重试。 */
async function load(force = false): Promise<void> {
    if (!force && personas().length > 0 && models().length > 0) return;
    if (loading) return loading;
    setBusy(true);
    loading = (async () => {
        try {
            const r = await diyService.diy.agent.persona.list({});
            setPersonas(r.personas);
            setDefaultPersona(r.default);
            setFollowCount(r.followCount);
        } catch (e) {
            console.warn("[persona] 人物清单加载失败（下次进入重试）:", e);
        }
        try {
            const ms = await diyService.diy.agent.local.models({});
            setModels(ms);
        } catch (e) {
            console.warn("[persona] 模型清单加载失败（下次进入重试）:", e);
        }
    })().finally(() => {
        loading = null;
        setBusy(false);
    });
    return loading;
}

/**
 * 把某个任务换绑到另一个人物（**续聊**：会话日志与上下文一律不动，下一轮起用新模型）。
 *
 * `id` 传 `""`（`PERSONA_FOLLOW`）= **跟随缺省**：删掉任务的 persona 键，之后缺省变它就跟着变。
 * 三态语义在 main/core/task.ts（不传=保持 / ""=跟随缺省 / 值=固定绑定）。
 *
 * 与「改人物定义」（CLI `diy agent persona set`）是两件事：这个方法影响**一个任务**，
 * 那个影响所有引用该人物的任务 —— 混在一起必然误操作，故界面上也分开（此处只换绑）。
 */
async function setForTask(taskUri: string, id: string): Promise<boolean> {
    try {
        // 只改 persona（未传的字段 = 保持原值，三态语义见 main/core/task.ts）；
        // 与「改人物定义」分离 —— 那条走 CLI `diy agent persona set`，影响所有引用者。
        await editTask(taskUri, { persona: id });
        // 只刷新当前选中任务的详情（不重拉整棵树：人物不影响树结构，且避免树刷新打断阅读位置）
        await taskStore.refreshSelected();
        return true;
    } catch (e) {
        console.error(`[persona] 换绑失败 ${taskUri} → ${id}:`, e);
        notificationStore.addToast(
            "error",
            `切换人物失败：${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
    }
}

/**
 * 保存人物定义（新建或更新；未给的字段保持原值 —— main 侧的三态语义）。
 * 成功后 reload：引用计数与模型清单都可能变（新建后列表要出现它）。
 */
async function save(patch: {
    id?: string;
    name?: string;
    model?: string;
    reasoningEffort?: string;
    instructions?: string;
}): Promise<string | null> {
    try {
        // 不传 id = 新建（id 由 main 生成并返回）；传 id = 更新该人物
        const r = await diyService.diy.agent.persona.set({
            id: patch.id,
            name: patch.name,
            model: patch.model,
            reasoningEffort: patch.reasoningEffort,
            instructions: patch.instructions,
        });
        await load(true);
        return r.id;
    } catch (e) {
        // 失败必须发声（如未知模型/档位不支持）：静默会让用户以为改成功了
        console.error(`[persona] 保存失败 ${patch.id ?? "(新建)"}:`, e);
        notificationStore.addToast(
            "error",
            `保存人物失败：${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
    }
}

/** 设为缺省人物（只影响之后新建的任务） */
async function setDefault(id: string): Promise<boolean> {
    try {
        await diyService.diy.agent.persona.setDefault({ id });
        await load(true);
        const name = personas().find((p) => p.id === id)?.name ?? id;
        notificationStore.addToast("success", `缺省人物已改为「${name}」（只影响之后新建的任务）`);
        return true;
    } catch (e) {
        console.error("[persona] setDefault 失败:", e);
        notificationStore.addToast(
            "error",
            `设置缺省人物失败：${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
    }
}

/** 把**当前选中的任务**换绑到该人物（面板里的「用于本任务」） */
async function bindCurrentTask(id: string): Promise<boolean> {
    const uri = taskStore.selectedUri;
    if (!uri) {
        notificationStore.addToast("error", "没有选中的任务");
        return false;
    }
    return setForTask(uri, id);
}

/**
 * 已尝试过"补拉"的 id（避免未知 id 触发无限重拉）。
 * 场景：CLI 新建/改名人物后，renderer 的清单是旧的 —— 界面会显示成"Agent/加载中"，
 * 看着像功能坏了，其实只是缓存陈旧。这里对**用到的** id 补一次强制刷新。
 */
const refetchTried = new Set<string>();

export const personaStore = {
    get personas() {
        return personas();
    },
    get defaultPersona() {
        return defaultPersona();
    },
    get models() {
        return models();
    },
    /** 跟随缺省的任务数（"改缺省会影响谁"的那批） */
    get followCount() {
        return followCount();
    },
    /** 清单加载中（异步在途；面板显示加载态用） */
    get loading() {
        return busy();
    },
    /**
     * 当前任务是否**跟随缺省**（frontmatter 里没有 persona 键）。
     *
     * 「没写键」与「写了但指向缺省」是**两种不同状态**，界面必须分开显示：
     * 前者改缺省会跟着变，后者不会。判据只看字段在不在（main 侧同一判据）。
     */
    isFollowing(): boolean {
        return !taskStore.selectedTask?.persona;
    },
    /**
     * 当前任务**实际生效**的人物 id。
     *
     * 跟随缺省时自然是缺省人物的 id；未加载完时也先用缺省（避免显示空白）。
     * 注意这是"现在谁在干活"的解析结果，**不是**任务的绑定 —— 要判绑定用 isFollowing()。
     */
    idForTask(): string {
        return taskStore.selectedTask?.persona || defaultPersona();
    },
    /** 缺省人物的名字（面板"跟随缺省"行显示"现在生效：X"；清单未到时回 id/占位） */
    defaultPersonaName(): string {
        const id = defaultPersona();
        return personas().find((p) => p.id === id)?.name ?? (id || "加载中…");
    },
    /** 按 id 取人物（含引用计数；未加载/不存在时 null，调用方自己决定怎么显示） */
    defOf(id: string): PersonaView | null {
        return personas().find((p) => p.id === id) ?? null;
    },

    /**
     * 取"这条消息实际会由谁回答"的人物 —— 面板/署名行都走它。
     *
     * 解析顺序刻意与 main 的 `personaForTask` 对齐（界面必须显示**真正会发生的事**）：
     *   ① 按 id 命中 → 就用它（正常情况）
     *   ② 按**名字**命中 → 旧数据把名字当引用（迁移前/手改）；main 侧按 id 找不到会回落缺省，
     *      但界面能按名字认出人来更准确
     *   ③ 都没有 → **缺省人物**（main 侧正是这么回落的，只是会出声告警）
     *
     * 为什么不能返回 null 了事：null 会让界面显示"选择人物/Agent"，
     * 而实际上 main 照常解析出一个人物并回答问题 —— 这就是"界面说没准备好、功能却是好的"，
     * 比不显示更糟（用户会以为配置丢了）。显示回落结果才是诚实的。
     *
     * 顺带自愈：清单是缓存，人物可被 CLI/另一窗口改动；找不到时补拉一次（每 key 只补一次，防循环）。
     */
    defOfLive(key: string): PersonaView | null {
        const list = personas();
        const hit = list.find((p) => p.id === key) ?? list.find((p) => p.name === key);
        if (hit) return hit;
        if (key && !refetchTried.has(key) && !loading) {
            refetchTried.add(key);
            void load(true);
        }
        // 回落缺省（与 main 的 personaForTask 同一语义）：能显示就显示，不装作"没有"
        return list.find((p) => p.id === defaultPersona()) ?? list[0] ?? null;
    },
    // 不提供"模型 id → 显示名"的映射：上游的显示名与 id 经常对不上（同一 id 在不同批次
    // 叫法不同、或清单里的 name 是历史遗留），于是"界面显示 X、实际发的是 Y"。
    // 模型一律**直接用 id** 展示 —— 它才是发给上游的那个值，也是配置里存的那个值。
    /** 某模型支持的思考级别（平铺按钮候选；模型未知时给空数组，界面自己兜底显示） */
    reasoningChoices(model: string): ReasoningEffort[] {
        return findModelBrief(model)?.reasoning.supported ?? [];
    },
    /**
     * 某模型的**默认**档位（null = 模型未知/清单未到）。
     *
     * 新建人物时要用：换模型后旧档位可能不在新模型的支持集内，此时必须落回**新模型的默认档**，
     * 否则会写出一个上游必拒的组合（400 Invalid request parameters）—— 写入侧也会拦，但那是事后报错。
     */
    defaultReasoning(model: string): ReasoningEffort | null {
        return findModelBrief(model)?.reasoning.default ?? null;
    },
    load,
    save,
    setDefault,
    bindCurrentTask,
    setForTask,
    /** 本任务改为**跟随缺省**（取消固定绑定）。缺省变它就跟着变，模型由事件流每 step 记录。 */
    async followDefault(): Promise<boolean> {
        const uri = taskStore.selectedUri;
        if (!uri) {
            notificationStore.addToast("error", "没有选中的任务");
            return false;
        }
        const ok = await setForTask(uri, "");
        if (ok)
            notificationStore.addToast(
                "success",
                "已改为跟随缺省人物（缺省改变时本任务下一轮跟着变）",
            );
        return ok;
    },
};

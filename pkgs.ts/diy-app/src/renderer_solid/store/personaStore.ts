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
    id: string;
    name: string;
    reasoning: { supported: ReasoningEffort[]; default: ReasoningEffort };
}

const [personas, setPersonas] = createSignal<PersonaView[]>([]);
const [defaultPersona, setDefaultPersona] = createSignal<string>("");
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
        } catch (e) {
            console.warn("[persona] 人物清单加载失败（下次进入重试）:", e);
        }
        try {
            setModels(await diyService.diy.agent.local.models({}));
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
 * 与「改人物定义」（CLI `diy agent persona set`）是两件事：这个方法影响**一个任务**，
 * 那个影响所有引用该人物的任务 —— 混在一起必然误操作，故界面上也分开（此处只换绑）。
 */
async function setForTask(taskUri: string, name: string): Promise<boolean> {
    try {
        // 只改 persona（未传的字段 = 保持原值，三态语义见 main/core/task.ts）；
        // 与「改人物定义」分离 —— 那条走 CLI `diy agent persona set`，影响所有引用者。
        await editTask(taskUri, { persona: name });
        // 只刷新当前选中任务的详情（不重拉整棵树：人物不影响树结构，且避免树刷新打断阅读位置）
        await taskStore.refreshSelected();
        return true;
    } catch (e) {
        console.error(`[persona] 换绑失败 ${taskUri} → ${name}:`, e);
        notificationStore.addToast("error", `切换人物失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

/**
 * 保存人物定义（新建或更新；未给的字段保持原值 —— main 侧的三态语义）。
 * 成功后 reload：引用计数与模型清单都可能变（新建后列表要出现它）。
 */
async function save(
    name: string,
    patch: { model?: string; reasoningEffort?: string; style?: string; desc?: string },
): Promise<boolean> {
    try {
        await diyService.diy.agent.persona.set({
            name,
            model: patch.model,
            reasoningEffort: patch.reasoningEffort,
            style: patch.style,
            desc: patch.desc,
        });
        await load(true);
        return true;
    } catch (e) {
        // 失败必须发声（如未知模型/档位不支持）：静默会让用户以为改成功了
        console.error(`[persona] 保存失败 ${name}:`, e);
        notificationStore.addToast("error", `保存人物失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

/** 设为缺省人物（只影响之后新建的任务） */
async function setDefault(name: string): Promise<boolean> {
    try {
        await diyService.diy.agent.persona.setDefault({ name });
        await load(true);
        notificationStore.addToast("success", `缺省人物已改为「${name}」（只影响之后新建的任务）`);
        return true;
    } catch (e) {
        console.error("[persona] setDefault 失败:", e);
        notificationStore.addToast("error", `设置缺省人物失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

/** 把**当前选中的任务**换绑到该人物（面板里的「用于本任务」） */
async function bindCurrentTask(name: string): Promise<boolean> {
    const uri = taskStore.selectedUri;
    if (!uri) {
        notificationStore.addToast("error", "没有选中的任务");
        return false;
    }
    return setForTask(uri, name);
}

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
    /** 清单加载中（异步在途；面板显示加载态用） */
    get loading() {
        return busy();
    },
    /** 当前任务的生效人物名：任务绑定优先，未加载完时先用缺省人物（避免显示空白） */
    nameForTask(): string {
        return taskStore.selectedTask?.persona || defaultPersona();
    },
    /** 按名字取人物（含引用计数；未加载/不存在时 null，调用方自己决定怎么显示） */
    defOf(name: string): PersonaView | null {
        return personas().find((p) => p.name === name) ?? null;
    },
    /** 模型 id → 人读名（清单未加载时退回 id 本身） */
    modelLabel(id: string): string {
        return models().find((m) => m.id === id)?.name ?? id;
    },
    /** 某模型支持的思考级别（下拉候选；模型未知时给空数组，界面自己兜底显示） */
    reasoningChoices(model: string): ReasoningEffort[] {
        return models().find((m) => m.id === model)?.reasoning.supported ?? [];
    },
    load,
    save,
    setDefault,
    bindCurrentTask,
    setForTask,
};

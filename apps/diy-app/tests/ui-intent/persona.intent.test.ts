/**
 * persona-ui.intent.test.ts — 【意图测试 · 界面层】人物面板的需求说明书。
 *
 * 读法同 `persona.intent.test.ts`：`it` 是需求，不是"测某个函数"。
 * 这一层关心的是**用户看到的界面做了什么**：面板开没开、开着谁、改名后界面认不认。
 *
 * 与 e2e 的分工（`tests/e2e/persona-panel.e2e.test.ts`）：
 *   · 这里：状态对不对（面板开了、选中是对的、名字改了没）——走 rpc 驱动，稳定且快；
 *   · e2e  ：看起来对不对（浮层会不会被裁、滚得到不到位、hover 显不显形）——真鼠标，慢且脆。
 *
 * 之所以能"真 app 却不用鼠标"：`diy.ui.persona.*` 是 main 转发给 renderer 的真通道，
 * 测试直接用一条长连 rpc 驱动它，省掉每条断言起 CLI（0.68s）与 CDP 轮询。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTypedClient } from "@diy-agent/rpc";
import { HttpClientBinding } from "@diy-agent/rpc/http";
import { apiDef } from "../../src/main/services/api-def";
import { startElectronTest, type ElectronTest } from "../electron-test";

let electron: ElectronTest;
let rpc: ReturnType<typeof createTypedClient<typeof apiDef>>;

beforeAll(async () => {
    electron = await startElectronTest(); // 真 app，隔离 HOME
    rpc = createTypedClient<typeof apiDef>(new HttpClientBinding(`http://127.0.0.1:${String(electron.port)}`), apiDef);
}, 90_000);

afterAll(async () => {
    await electron?.stop();
});

describe("人物面板：点开它、改一个人、再关上", () => {
    it("平时面板是收起的，不挡着用户干活", async () => {
        const st = (await rpc.diy.ui.persona.state({})) as { data: { open: boolean } };
        expect(st.data.open).toBe(false);
    });

    it("打开面板时可以直接指定要看谁", async () => {
        const list = (await rpc.diy.agent.persona.list({})) as { personas: { id: string; name: string }[] };
        const target = list.personas[0]!;
        await rpc.diy.ui.persona.open({ id: target.id });
        const st = (await rpc.diy.ui.persona.state({})) as { data: { open: boolean; id: string | null } };
        expect(st.data.open).toBe(true);
        expect(st.data.id).toBe(target.id);
    });

    it("在面板里给人物改名：名字立刻生效，面板还停在这人身上", async () => {
        const list = (await rpc.diy.agent.persona.list({})) as { personas: { id: string; name: string }[] };
        const target = list.personas[0]!;
        const newName = `${target.name}-rpc改名`;
        await rpc.diy.agent.persona.set({
            id: target.id,
            name: newName,
            model: undefined,
            reasoningEffort: undefined,
            instructions: undefined,
        });
        const after = (await rpc.diy.agent.persona.list({})) as { personas: { id: string; name: string }[] };
        expect(after.personas.find((p) => p.id === target.id)?.name).toBe(newName);
        const st = (await rpc.diy.ui.persona.state({})) as { data: { open: boolean; id: string | null } };
        expect(st.data.open).toBe(true);
        expect(st.data.id).toBe(target.id);
    });

    it("关掉面板后界面回到原来的样子", async () => {
        await rpc.diy.ui.persona.close({});
        const st = (await rpc.diy.ui.persona.state({})) as { data: { open: boolean } };
        expect(st.data.open).toBe(false);
    });
});

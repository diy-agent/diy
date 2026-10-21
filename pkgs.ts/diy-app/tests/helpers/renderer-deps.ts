// tests/helpers/renderer-deps.ts
// 🎯 renderer 单测的依赖装配（##402）—— 替代旧的 `vi.mock(".../lib/rpc")` 三件套。
//
// 为什么不用 vi.mock：它替换的是**全局模块表**，`isolate:false` 下模块每个 worker 只求值一次，
// 谁先加载了真实现，后面的 mock 就**静默失效**（测试对错取决于文件落进哪个 worker / 什么顺序）。
// 这里全部改成**显式注入**：
//   · rpc：`setDiyService(假实现)`（见 src/renderer_solid/lib/rpc.ts 的懒建门面）
//   · notificationStore.addToast：`vi.spyOn`（对象方法，本进程内改，不涉模块表）
//   · personaStore.load：同上（本类用例不关心人物清单）
//
// ⚠️ 调用顺序：先 `vi.resetModules()`，再调用这些（保证你拿到的 store 与这里注入的是**同一份**
// 模块实例）；resetModules 之后动态 import 的模块都指向新实例。
import { vi } from "vitest";

/** 把 renderer 的 RPC 客户端换成本用例的假实现。`service` 形状随意（门面按属性转发）。 */
export async function installRpc(service: unknown): Promise<void> {
    const rpc = await import("../../src/renderer_solid/lib/rpc");
    rpc.setDiyService(service as never);
}

/** 把 `notificationStore.addToast` 换成给定实现（返回 spy，便于断言调用）。 */
export async function stubToasts(impl: (...args: unknown[]) => void = () => {}): Promise<ReturnType<typeof vi.fn>> {
    const { notificationStore } = await import("../../src/renderer_solid/store/notificationStore");
    vi.spyOn(notificationStore, "addToast").mockImplementation(impl as never);
    return impl as ReturnType<typeof vi.fn>;
}

/** `personaStore.load` 变 no-op（人物清单与本类用例无关；真实现会打 RPC）。 */
export async function stubPersonaLoad(): Promise<void> {
    const { personaStore } = await import("../../src/renderer_solid/store/personaStore");
    vi.spyOn(personaStore, "load").mockResolvedValue(undefined);
}

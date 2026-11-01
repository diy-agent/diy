// strategies/types.ts — provider 策略接口（##491）
//
// 一句话：**某个 provider 的私有约定（网关专属请求字段 / 必需 header），写在它自己的策略文件里，
// 不写在应用层，也不写成「按 provider 名分支」的 if / switch**。
//
// 为什么：这些约定既不能放在 diy-app（应用层不该知道 "prompt_cache_retention" 这种字段名），
// 也不适合塞进通用表（表是「名字 → endpoint」的数据，不是行为）。策略 = 行为，按 host 认领。
//
// 两条硬边界：
//   ① 只做**已验证**的差异：没实测过的字段不发（默认走 passthrough，什么都不加）
//   ② 纯函数：不读环境变量、不碰文件、不发请求 —— `ctx` 里缺什么就整体跳过那个变换

/** 策略执行上下文：调用方算好传进来，策略自己**不推算**（比如会话 id 由应用按任务算） */
export interface StrategyContext {
    /** 会话 id；缺席 = 没有会话概念（需要它的变换整体跳过） */
    readonly sessionId?: string;
}

/**
 * 一个 provider 的策略。
 *
 * 加新 provider = **新增一个文件** + 在 `index.ts` 的注册表里加一行；
 * 不许在策略里按 provider 名分支（if / switch 都不行；判据会 grep）。
 */
export interface ProviderStrategy {
    /** 策略名（日志 / 调试用；不是 provider 名，也不参与匹配） */
    readonly name: string;
    /** 认领判据：按 **host** 判，不看 provider 名（名是调用方自己起的路由名，可随意改） */
    matches(baseUrl: string): boolean;
    /** 请求体变换（**不改原对象**；返回新对象；不改 = 不实现） */
    transformBody?(body: Record<string, unknown>, ctx: StrategyContext): Record<string, unknown>;
    /** 请求头变换（**不改原对象**；返回新对象；不改 = 不实现） */
    transformHeaders?(headers: Record<string, string>, ctx: StrategyContext): Record<string, string>;
}

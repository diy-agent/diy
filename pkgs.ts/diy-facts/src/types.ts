// types.ts — 事实的静态形状（唯一真源：字段表从这里推导，别处不抄）
//
// 三条粒度必须分开（##404「设计定案」）：
//   subject  —— 描述的对象（`app.port`），受控词表
//   claim    —— `subject#aspect`，**派生查询键**（不落真源、可重算）
//   fact.id  —— **稳定审计锚点**（`supersedes.to` 指向它、证据挂在它上，不可派生）
//
// 「变体」是**语义**不是存储形状：真源一行一 fact，变体差异靠 `scope` 表达，
// 读取时由 resolve 按当前 scope 挑选（见 scope.ts / resolve.ts）。

/**
 * 环境轴 —— 对齐 **`DIY_ENV`**（不是 `DIY_VARIANT`）。
 *
 * 为什么不与 variant 对齐：`DIY_VARIANT` 只决定**产物/数据分根**（prod / test / lab），
 * 而事实值（行为）由 `DIY_ENV` 决定 —— `defaultPort(env)` 就是按 env 分的
 * （production=18888，development/test=0）。`lab` 只是 development 的一种实例形态。
 * 两套轴混用会在 `lab` 与 `development` 之间打架，故事实只认 env；
 * `variant → env` 的映射由消费侧（diy-app）负责。
 */
export type Env = 'production' | 'development' | 'test';

/**
 * 事实成立的范围（三轴正交，缺省 = 全局）。
 * 冲突判据 = `subject + aspect + scope(三轴全等)`；任何一轴不同 = 并存的合法事实。
 */
export interface Scope {
    /** 适用的环境；数组 = 同一值覆盖多个环境 */
    readonly env?: Env | readonly Env[];
    /** 适用的代码位置（前缀，按路径段边界匹配） */
    readonly paths?: readonly string[];
    /** 适用的任务（任务 URIs 形如 `projects/4/tasks/404`） */
    readonly task?: string;
}

/** 审核状态（与生命周期**正交**，别混用） */
export type Review = 'proposed' | 'accepted' | 'rejected';

/** 生命周期（`superseded` = 被替代后仍可追溯；`expired` = 探针失效） */
export type Lifecycle = 'active' | 'superseded' | 'expired';

/** 证据来源分档：可计算 > 可定位 > 意图/推断（决定能不能自动 accepted） */
export type Source = 'user' | 'probe' | 'code' | 'inference';

export interface Evidence {
    readonly source: Source;
    /** 可定位证据 `<路径>:<行>`（code / user 档常用） */
    readonly at?: string;
    /** 可执行探针命令（probe 档必须有） */
    readonly probe?: string;
    /** 探针输出的指纹（只存指纹，不存输出 —— 日志可清可丢） */
    readonly probeDigest?: string;
    /** 最近一次实际验证时间（ISO-8601，由调用方传入） */
    readonly verifiedAt?: string;
}

/**
 * 关系边。判别键 `rel` 与私有载荷 `data` 分居（rule.discriminated-union）。
 *
 * 目标粒度**按关系类型而异**，这是刻意的：
 *   - `depends-on` 指向 **claim**（跨环境取正确变体；指向 fact id 会把 scope 写死）
 *   - `supersedes` 指向 **fact id**（替代关系是一条记录替代另一条记录）
 */
export type Ref =
    | {
          readonly rel: 'depends-on';
          readonly data: {
              /** `subject#aspect` */
              readonly toClaim: string;
              /** 该依赖只在满足此 scope 时成立 */
              readonly when?: Scope;
          };
      }
    | {
          readonly rel: 'supersedes';
          readonly data: {
              readonly toFactId: string;
              /** 替代只在满足此 scope 时成立（缺省 = 全面替代） */
              readonly within?: Scope;
          };
      };

export type Rel = Ref['rel'];

export interface Fact {
    /** 稳定、不可派生；改名 = 新 id + `supersedes` 边 */
    readonly id: string;
    /** 对象（词表见 vocab） */
    readonly subject: string;
    /** 方面（`default` / `优先级` / `落点`…） */
    readonly aspect: string;
    /** 事实值（字符串；结构化值序列化后存放） */
    readonly value: string;
    readonly scope?: Scope;
    readonly review: Review;
    readonly lifecycle: Lifecycle;
    readonly evidence: Evidence;
    readonly refs?: readonly Ref[];
}

/** 机器判据错误码（CLI / 日志 / 测试同一份，便于按频次统计） */
export type FactsErrorCode =
    | 'facts/schema'
    | 'facts/id-duplicate'
    | 'facts/scope-duplicate'
    | 'facts/scope-conflict'
    | 'facts/scope-no-match'
    | 'facts/claim-unknown'
    | 'facts/rel-unknown'
    | 'facts/dangling-ref'
    | 'facts/supersede-cycle'
    | 'facts/vocab-unknown'
    | 'facts/ns-invalid'
    // 词表删除（`submit` 的 `dropSubjects`）：三条各自对应一种「删不得」
    | 'facts/subject-drop-in-use'
    | 'facts/subject-drop-not-local'
    | 'facts/subject-drop-declared';

/** 结构化结果（读取侧「悬空 / 冲突」是**可预期结果**，不是异常） */
export type Result<T> =
    | { readonly ok: true; readonly value: T }
    | {
          readonly ok: false;
          readonly code: FactsErrorCode;
          readonly detail?: string;
          /** 涉事 fact id（冲突 / 悬空时给出，便于人去看） */
          readonly facts?: readonly string[];
      };

export function ok<T>(value: T): Result<T> {
    return { ok: true, value };
}

export function fail<T>(code: FactsErrorCode, detail?: string, facts?: readonly string[]): Result<T> {
    return facts === undefined ? { ok: false, code, detail } : { ok: false, code, detail, facts };
}

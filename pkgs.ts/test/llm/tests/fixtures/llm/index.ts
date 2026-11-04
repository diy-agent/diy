// fixtures/llm/index.ts — 场景清单
//
// 每份 fixture 都是**源码常量**（.ts），不是数据文件：
//   协议变了 → 编译报错 → 逼你重录；存储版本变了 → 完全不受影响。
//
// 重录单个：node --experimental-strip-types tools/record-llm.mts <kebab-name>
// 看状态：  node --experimental-strip-types tools/record-llm.mts list

export { textOnly } from "./text-only.js";
export { toolOk } from "./tool-ok.js";
export { abort } from "./abort.js";

// 待录（录完取消注释并加对应 export）：
//   think            think.ts            带推理的回复
//   toolError        tool-error.ts       工具失败后怎么收尾
//   toolMultiStep    tool-multi-step.ts  连续两次工具调用
//   modelUnavailable model-unavailable.ts 上游 404/401
//   rateLimit        rate-limit.ts       429 + 重试
//   contextOverflow  context-overflow.ts 压缩触发
//   empty            empty.ts            done 但零内容

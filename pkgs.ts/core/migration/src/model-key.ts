/**
 * 占位模型键：老库里拿它表示「没配模型」。
 *
 * 它不是「选了个模型」：读的时候当空串（= 继续继承），写的时候别再让它进去 ——
 * 否则界面会拼出「none · none@none」看着像配好了、发出去必失败。
 *
 * 单独放一个文件（而不是留在 db.ts 里）：迁移脚本也要用它判断「占位值清干净没」，
 * 而 db.ts 依赖 migrations/，再从 migrations/ 反向 import db.ts 会成环。
 */
export const PLACEHOLDER_MODEL_KEY = 'none@none/none';

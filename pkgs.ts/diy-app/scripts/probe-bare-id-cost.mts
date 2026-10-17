// scripts/probe-bare-id-cost.mts
// 🎯 复现探针（##372）：上游裸 modelId 歧义 → costOf 静默 null → 会话金额恒为 0
//
// 用法（**只读**，不写任何数据根）：
//   npx tsx scripts/probe-bare-id-cost.mts [--home ~/.diy] [--id deepseek-v4.1-flash] [--ref 0@opencode-go/deepseek-v4.1-flash]
//
// 判据（修前 / 修后的差别就在第 2 行）：
//   ① `costOf(<裸 id>)`            —— **修前 null**（裸 id 被 ≥2 家 provider 收录 → findModel 判歧义）
//   ② `ratesOfModel(findPricedModel(<裸 id>, <本请求限定 ref>))` —— **修后非 null**（限定 provider 后命中）
//     （① 是本任务的病灶调用点原先走的那条路；② 是修后的新路径。②仍为 null 说明真的无价目。）
//
// 为什么要用**当前 `~/.diy` 真配置**跑：歧义只在"同一 id 确实被两家 provider 收录"时出现，
// 假数据造不出这个事实（真配置见 ~/.diy/model.yaml + models.dev 快照）。
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshModelRuntime } from "../src/main/core/model-runtime";
import { costOf, findModel, findPricedModel, getModelCatalog, ratesOfModel } from "../src/shared/models";

const argOf = (name: string, dflt: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
};

const home = argOf("home", process.env["DIY_HOME"] ?? join(homedir(), ".diy"));
const id = argOf("id", "deepseek-v4.1-flash");
const ref = argOf("ref", `0@opencode-go/${id}`);

const n = refreshModelRuntime(home);
console.log(`数据根 ${home} · 目录 ${n} 条模型`);

// ① 裸 id 的「收录数」与歧义事实
const hits = getModelCatalog().filter((m) => m.id === id);
const providers = [...new Set(hits.map((m) => m.provider))];
console.log(`\n裸 id \`${id}\`：目录里 ${hits.length} 条，覆盖 provider ${providers.length} 家 → [${providers.join(", ")}]`);

const bare = costOf(id, 1000);
console.log(`① costOf("${id}", 1000)                        = ${bare ? JSON.stringify(bare) : "null"}   ← 修前病灶（null = 金额恒 0）`);
console.log(`   findModel("${id}")                          = ${findModel(id) ? findModel(id)!.ref : "undefined（歧义，不猜）"}`);

// ② 限定到本请求的 provider/account 后重查（修后的路径）
const priced = findPricedModel(id, ref);
const rates = ratesOfModel(priced.model, 1000);
console.log(`\n② findPricedModel("${id}", "${ref}")`);
console.log(`   → basis=${priced.basis} · model=${priced.model?.ref ?? "undefined"}`);
console.log(`   ratesOfModel(...)                          = ${rates ? JSON.stringify(rates) : "null"}   ← 修后应非 null`);

// ③ vendor/id 形状（上游另一种回执形态）
const vendorShape = `${id.split("-")[0]}/${id}`;
const vp = findPricedModel(vendorShape, ref);
const vr = ratesOfModel(vp.model, 1000);
console.log(`\n③ vendor/id 形状 "${vendorShape}" → basis=${vp.basis} · model=${vp.model?.ref ?? "undefined"} · rates=${vr ? "非 null" : "null"}`);

// ④ 结论行（给验收用）
console.log(`\n结论：修前 costOf(裸 id) = ${bare ? "非 null" : "null"}；修后 ratesOfModel(findPricedModel(裸 id, 限定 ref)) = ${rates ? "非 null" : "null"}`);
process.exit(bare === null && rates !== null ? 0 : 1);

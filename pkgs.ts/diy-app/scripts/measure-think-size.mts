// 临时量测：reasoning 回传对历史体积的影响（##371 验收③）。
// 用法：npx tsx scripts/measure-think-size.mts <ops.jsonl> [...]
import fs from "node:fs";
import { replay, projectAll, type Op } from "../src/main/services/local-blocks";
import { utf8Bytes } from "@diy/compaction/compaction";

for (const file of process.argv.slice(2)) {
    const ops: Op[] = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Op);
    const store = replay(ops);
    const before = projectAll(store);
    const bytesBefore = utf8Bytes(JSON.stringify(before));
    let thinkBlocks = 0;
    let thinkChars = 0;
    for (const b of store.blocks.values()) {
        if (b.kind !== "think") continue;
        const t = String(b.content ?? "");
        if (t) {
            thinkBlocks++;
            thinkChars += t.length;
            b.content = "";
        }
    }
    const after = projectAll(store);
    const bytesAfter = utf8Bytes(JSON.stringify(after));
    const pct = ((bytesBefore / bytesAfter - 1) * 100).toFixed(1);
    console.log(
        `${file.split("/").pop()}\n` +
            `  消息数 ${after.length}（不变: ${before.length === after.length}）\n` +
            `  投递字节 修前 ${bytesAfter} → 修后 ${bytesBefore}（+${bytesBefore - bytesAfter}，+${pct}%）\n` +
            `  非空 think 块 ${thinkBlocks} 个，思考文本 ${thinkChars} 字符\n` +
            `  op 行数 ${ops.length}`,
    );
}

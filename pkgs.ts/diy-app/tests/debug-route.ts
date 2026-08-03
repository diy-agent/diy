// Quick debug: test routeResolve with the actual API
import { buildRouteTree, routeResolve } from "@diy/rpc";
import { apiDef } from "../src/main/services/api-def";

const tree = buildRouteTree(apiDef);

console.log("Root children:");
for (const c of tree.children) {
  console.log(`  ${c.kind}: name="${c.name}" path="${c.path}"`);
  if (c.kind === "router") {
    for (const cc of c.children) {
      console.log(`    ${cc.kind}: name="${cc.name}" path="${cc.path}"`);
    }
  }
}

console.log("\nresolve ref list:", routeResolve(tree, ["diy", "app", "ref", "list"]));
console.log("resolve task create:", routeResolve(tree, ["diy", "app", "task", "create"]));
console.log("resolve ref:", routeResolve(tree, ["diy", "app", "ref"]));

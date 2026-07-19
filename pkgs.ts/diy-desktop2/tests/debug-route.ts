// Quick debug: test routeResolve with the actual API
import { buildRouteTree, routeResolve } from "@diy/rpc";
import { api } from "../src/main/services/api";

const tree = buildRouteTree(api);

console.log("Root children:");
for (const c of tree.children) {
  console.log(`  ${c.kind}: name="${c.name}" path="${c.path}"`);
  if (c.kind === "router") {
    for (const cc of c.children) {
      console.log(`    ${cc.kind}: name="${cc.name}" path="${cc.path}"`);
    }
  }
}

console.log("\nresolve ref list:", routeResolve(tree, ["ref", "list"]));
console.log("resolve task create:", routeResolve(tree, ["task", "create"]));
console.log("resolve ref:", routeResolve(tree, ["ref"]));

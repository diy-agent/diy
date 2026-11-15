#!/usr/bin/env bash
#
# 本 app 的 mono 入口（`./sha.sh exec` / `clean` / 各包 `check` 靠它发现这个包）。
#

# shellcheck disable=SC2329,SC2317,SC2034
set -o errtrace -o errexit -o functrace -o pipefail
shopt -s globstar extglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
source "../../sha.common.sh"

clean() {
  run rm -rf ./build ./dist ./node_modules/.cache/tsbuildinfo ./tsconfig.tsbuildinfo
}

sync() { :; }

check() {
  typecheck
  lint
}
fix() {
  fmt-fix
  lint-fix
}

# build：UI（vite）+ 服务端（vite lib/ssr，含工作区包）→ build/prod/{web,server}
# 全局命令 bin/diy2 只认这个产物，不再需要 tsx / vite 在运行时
build() { run npm run build; }
build-web() { run npm run build:web; }
build-server() { run npm run build:server; }

# 本地试跑构建产物（等价于 npm link 之后敲 diy2）
start() { run node bin/diy2 "$@"; }

typecheck() { run npx tsc --noEmit; }
lint() { run npx oxlint src/ server/; }
lint-fix() { run npx oxlint --fix src/ server/; }
fmt() { run npx oxfmt --check src/ server/; }
fmt-fix() { run npx oxfmt --write src/ server/; }

sha "$@"

#!/bin/sh
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1
command -v node >/dev/null 2>&1 || { printf '%s\n' '需要安装 Node.js 24 或更新版本' >&2; exit 1; }
exec node "$script_dir/scripts/start.mjs" "$@"

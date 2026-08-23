#!/usr/bin/env bash
# MCP launcher: resolve the gitmem root (creating .gitmem on first use) and serve.
. "$(dirname "$0")/find-root.sh"

command -v gitmem >/dev/null 2>&1 || {
  echo "gitmem CLI not found on PATH — install it first (see https://github.com/josephy02/gitmem)" >&2
  exit 1
}

root=$(gitmem_find_root)
root="${root:-.gitmem}"
[ -f "$root/gitmem.config.json" ] || gitmem --root "$root" init >/dev/null 2>&1

exec gitmem --root "$root" serve

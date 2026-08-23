#!/usr/bin/env bash
# SessionStart hook: print the gitmem brief to stdout so it lands in context.
# Silent no-op when there's no gitmem root or the CLI isn't installed.
. "$(dirname "$0")/find-root.sh"

root=$(gitmem_find_root)
[ -z "$root" ] && exit 0
command -v gitmem >/dev/null 2>&1 || exit 0

brief=$(gitmem --root "$root" brief 2>/dev/null) || exit 0
[ -z "$brief" ] && exit 0

printf 'Persistent memory (gitmem, root: %s). Contradicted or stale entries may exist — run `gitmem conflicts` / `gitmem stale` to review. Save new durable facts and decisions with the memory_append MCP tool.\n\n%s\n' "$root" "$brief"

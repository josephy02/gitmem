#!/usr/bin/env bash
# Shared root discovery: GITMEM_ROOT env var, else a known directory containing
# gitmem.config.json, else empty. Sourced by brief.sh and serve.sh.
gitmem_find_root() {
  if [ -n "${GITMEM_ROOT:-}" ]; then
    printf '%s' "$GITMEM_ROOT"
    return
  fi
  for c in .gitmem memory .memory; do
    if [ -f "$c/gitmem.config.json" ]; then
      printf '%s' "$c"
      return
    fi
  done
}

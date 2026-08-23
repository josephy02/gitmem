---
description: Review contested and stale gitmem memories and propose resolutions
---

Review the health of persistent memory:

1. Call the `memory_conflicts` MCP tool. For each conflict, show both sides with provenance and ask me which is correct (or infer it from the codebase if it's checkable), then resolve by appending a `correction` that supersedes the losing event ids via `memory_append`.
2. Run `gitmem stale` in the shell (if a gitmem root exists). For each possibly-stale fact, check the anchored code and either confirm the fact still holds or append a correction.
3. Finish with a one-paragraph summary: how many conflicts resolved, how many stale facts confirmed or corrected.

Never delete or edit log files directly — all fixes go through append.

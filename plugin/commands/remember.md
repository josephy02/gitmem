---
description: Save a durable fact or decision to gitmem memory
---

Save the following to persistent memory using the gitmem `memory_append` MCP tool: $ARGUMENTS

Rules:
- One self-contained claim per event. If the input contains several distinct facts, append them separately.
- Use `kind: "decision"` when it records a choice ("we use X", "do not refactor Y"); `kind: "observation"` otherwise.
- Pick a scope from the existing scope hierarchy (check `memory_facts` if unsure); default to the project's top-level scope.
- If it contradicts or updates an existing memory, append it as a `correction` with `supersedes` set to the old event id instead of a plain observation.
- If no argument was given, review this conversation and save the durable facts and decisions worth keeping — skip anything the repo or git history already records.

Confirm what was saved with the returned event id(s).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GitMem } from "./gitmem.js";
import type { Capability, FactStatus } from "./types.js";

/** MCP server exposing gitmem over stdio. One tool per read/write surface;
 *  all reads go through the same capability choke point as the CLI. */
export async function serveMcp(root: string, cap: Capability, author: string): Promise<void> {
  const log = GitMem.open(root);
  const [akind, ...aid] = author.split(":");
  const server = new McpServer({ name: "gitmem", version: "0.1.0" });

  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  server.registerTool(
    "memory_append",
    {
      description:
        "Record a memory: a fact learned (observation), a choice made (decision), an amendment to an earlier memory (correction), or a withdrawal (retraction). Call this when you learn something durable about the project or user that future sessions should know. Returns the new event id.",
      inputSchema: {
        scope: z.string().describe("Hierarchical scope path, e.g. team/core/auth"),
        body: z.string().describe("The memory itself. One self-contained claim, <= 4000 chars."),
        kind: z.enum(["observation", "decision", "correction", "retraction"]).default("observation"),
        supersedes: z.array(z.string()).optional().describe("Event ids this corrects or retracts"),
        derived_from: z.array(z.string()).optional().describe("Event ids this was derived from"),
        confidence: z.number().min(0).max(1).optional(),
        ttl_hint: z.string().optional().describe("ISO date after which this is presumed stale"),
      },
    },
    async (args) => {
      const id = log.append({
        scope: args.scope,
        body: args.body,
        kind: args.kind,
        supersedes: args.supersedes,
        derived_from: args.derived_from,
        confidence: args.confidence,
        ttl_hint: args.ttl_hint,
        author: { kind: akind as "agent" | "human" | "system", id: aid.join(":") || "mcp" },
      });
      return text(id);
    },
  );

  server.registerTool(
    "memory_brief",
    {
      description:
        "Get the memory brief: a token-budgeted markdown summary of live facts and decisions, most important first. Call this at the start of a task to load prior context.",
      inputSchema: {
        scope: z.string().optional().describe("Restrict to a scope subtree; omit for all readable scopes"),
      },
    },
    async (args) => text(log.brief(cap, args.scope)),
  );

  server.registerTool(
    "memory_facts",
    {
      description:
        "List current facts as JSON. Each fact carries status (live/superseded/retracted/expired/contested), provenance, and confidence. Contested facts include their conflict partners.",
      inputSchema: {
        scope: z.string().optional(),
        status: z.enum(["live", "superseded", "retracted", "expired", "contested"]).optional(),
      },
    },
    async (args) =>
      text(JSON.stringify(log.facts(cap, { scope: args.scope, status: args.status as FactStatus }), null, 2)),
  );

  server.registerTool(
    "memory_conflicts",
    {
      description:
        "List unresolved contradictions between live facts. Resolve one by calling memory_append with kind=correction superseding the losing event ids.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(log.conflicts(cap), null, 2)),
  );

  server.registerTool(
    "memory_trace",
    {
      description: "Show an event and its full derivation ancestry (what it was derived from, recursively).",
      inputSchema: { id: z.string().describe("Event id (ULID)") },
    },
    async (args) => text(JSON.stringify(log.trace(cap, args.id), null, 2)),
  );

  await server.connect(new StdioServerTransport());
}

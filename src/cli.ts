#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { MemLog } from "./memlog.js";
import { ValidationError } from "./log.js";
import type { Capability, Config, FactStatus, MemEvent } from "./types.js";

const program = new Command().name("memlog").description("Git-native, append-only agent memory");
program.option("--root <path>", "memlog root", process.env.MEMLOG_ROOT ?? ".");
program.option("--as <principal>", "act as this principal from memlog.config.json");

function root(): string {
  return path.resolve(program.opts().root);
}

function capability(): Capability {
  const config = JSON.parse(fs.readFileSync(path.join(root(), "memlog.config.json"), "utf8")) as Config;
  const principal = program.opts().as as string | undefined;
  const cap = principal
    ? config.capabilities.find((c) => c.principal === principal)
    : config.capabilities[0];
  if (!cap) fail(`no capability for principal ${principal ?? "(default)"}`);
  return cap;
}

function fail(msg: string, code = 1): never {
  process.stderr.write(JSON.stringify({ error: msg }) + "\n");
  process.exit(code);
}

function run<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (err) {
      if (err instanceof ValidationError) fail(err.message);
      fail(err instanceof Error ? err.message : String(err));
    }
  };
}

program
  .command("init")
  .description("initialize a memlog root (git repo, config, merge driver)")
  .action(
    run(() => {
      const r = root();
      MemLog.init(r);
      if (!fs.existsSync(path.join(r, ".git"))) execFileSync("git", ["init", "-q"], { cwd: r });
      const gitignore = path.join(r, ".gitignore");
      if (!fs.existsSync(gitignore) || !fs.readFileSync(gitignore, "utf8").includes("proj/")) {
        fs.appendFileSync(gitignore, "proj/\n");
      }
      const attrs = path.join(r, ".gitattributes");
      const rule = "log/**/*.jsonl merge=memlog-union\n";
      if (!fs.existsSync(attrs) || !fs.readFileSync(attrs, "utf8").includes("memlog-union")) {
        fs.appendFileSync(attrs, rule);
      }
      execFileSync("git", ["config", "merge.memlog-union.name", "memlog union merge"], { cwd: r });
      execFileSync("git", ["config", "merge.memlog-union.driver", "memlog merge-driver %A %B"], { cwd: r });
      process.stderr.write(`initialized memlog root at ${r}\n`);
    }),
  );

program
  .command("append")
  .description("append one event; prints the new event id")
  .option("--scope <s>")
  .option("--kind <k>", "observation|decision|correction|retraction|promotion", "observation")
  .option("--body <text>")
  .option("--derived-from <ids>", "comma-separated event ids")
  .option("--supersedes <ids>", "comma-separated event ids")
  .option("--confidence <n>", "writer confidence in [0,1]", parseFloat)
  .option("--ttl <date>")
  .option("--author <kind:id>", "e.g. agent:builder-3", "human:owner")
  .option("--force", "bypass the ±24h clock-skew guard (imports)")
  .option("--json", "read one event (or NDJSON stream) from stdin")
  .argument("[file]", 'NDJSON file for --json, or "-" for stdin', "-")
  .action(
    run((file: string) => {
      const log = MemLog.open(root());
      const opts = (program.commands.find((c) => c.name() === "append") as Command).opts();
      if (opts.json) {
        const input = fs.readFileSync(file === "-" ? 0 : file, "utf8");
        for (const line of input.split("\n")) {
          if (line.trim() === "") continue;
          const e = JSON.parse(line) as Partial<MemEvent> & { force?: boolean };
          const id = log.append({
            scope: e.scope!,
            kind: e.kind ?? "observation",
            body: e.body!,
            author: e.author ?? { kind: "human", id: "owner" },
            derived_from: e.derived_from,
            supersedes: e.supersedes,
            confidence: e.confidence,
            ttl_hint: e.ttl_hint,
            meta: e.meta,
            id: e.id,
            ts: e.ts,
            force: opts.force ?? e.force,
          });
          process.stdout.write(id + "\n");
        }
        return;
      }
      if (!opts.scope || !opts.body) fail("--scope and --body are required");
      const [akind, ...aid] = (opts.author as string).split(":");
      const id = log.append({
        scope: opts.scope,
        kind: opts.kind,
        body: opts.body,
        author: { kind: akind as "agent" | "human" | "system", id: aid.join(":") },
        derived_from: opts.derivedFrom?.split(",").filter(Boolean),
        supersedes: opts.supersedes?.split(",").filter(Boolean),
        confidence: opts.confidence,
        ttl_hint: opts.ttl,
        force: opts.force,
      });
      process.stdout.write(id + "\n");
    }),
  );

program
  .command("project")
  .description("rebuild projections (incremental)")
  .option("--force")
  .action(run(() => void MemLog.open(root()).project({ force: true })));

program
  .command("rebuild")
  .description("always full rebuild")
  .action(run(() => void MemLog.open(root()).project({ force: true })));

program
  .command("brief")
  .description("print brief.md to stdout")
  .option("--scope <s>")
  .action(
    run(() => {
      const opts = (program.commands.find((c) => c.name() === "brief") as Command).opts();
      process.stdout.write(MemLog.open(root()).brief(capability(), opts.scope));
    }),
  );

program
  .command("facts")
  .description("list facts")
  .option("--scope <s>")
  .option("--status <status>", "live|superseded|retracted|expired|contested")
  .option("--json")
  .action(
    run(() => {
      const opts = (program.commands.find((c) => c.name() === "facts") as Command).opts();
      const facts = MemLog.open(root()).facts(capability(), {
        scope: opts.scope,
        status: opts.status as FactStatus | undefined,
      });
      if (opts.json) for (const f of facts) process.stdout.write(JSON.stringify(f) + "\n");
      else for (const f of facts) process.stderr.write(`[${f.status}] ${f.scope} ${f.body} (${f.author.id})\n`);
    }),
  );

program
  .command("conflicts")
  .description("list unresolved conflicts")
  .option("--json")
  .action(
    run(() => {
      const opts = (program.commands.find((c) => c.name() === "conflicts") as Command).opts();
      const conflicts = MemLog.open(root()).conflicts(capability());
      if (opts.json) for (const c of conflicts) process.stdout.write(JSON.stringify(c) + "\n");
      else for (const c of conflicts) process.stderr.write(`${c.id} [${c.detected_by}] ${c.members.join(" vs ")}\n`);
    }),
  );

program
  .command("show <id>")
  .description("event + full derivation chain")
  .action(
    run((id: string) => {
      const node = MemLog.open(root()).trace(capability(), id);
      process.stdout.write(JSON.stringify(node, null, 2) + "\n");
    }),
  );

program
  .command("trace <id>")
  .description("ancestry tree, one line per hop")
  .action(
    run((id: string) => {
      const node = MemLog.open(root()).trace(capability(), id);
      const walk = (n: typeof node, depth: number) => {
        process.stdout.write(`${"  ".repeat(depth)}${n.event.id} [${n.event.kind}] ${n.event.body.slice(0, 80)}\n`);
        for (const d of n.derived_from) walk(d, depth + 1);
      };
      walk(node, 0);
    }),
  );

program
  .command("stats")
  .description("per-scope statistics")
  .option("--scope <s>")
  .action(
    run(() => {
      const opts = (program.commands.find((c) => c.name() === "stats") as Command).opts();
      const p = MemLog.open(root()).project();
      const stats = opts.scope
        ? Object.fromEntries(Object.entries(p.stats).filter(([s]) => s === opts.scope || s.startsWith(opts.scope + "/")))
        : p.stats;
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    }),
  );

program
  .command("verify")
  .description("integrity check")
  .action(
    run(() => {
      const result = MemLog.open(root()).verify();
      if (!result.ok) {
        for (const e of result.errors) process.stderr.write(e + "\n");
        process.exit(2);
      }
      process.stderr.write(`ok: ${result.events} events\n`);
    }),
  );

program
  .command("commit")
  .description("stage log/ and commit")
  .option("-m, --message <msg>")
  .action(
    run(() => {
      const opts = (program.commands.find((c) => c.name() === "commit") as Command).opts();
      const r = root();
      execFileSync("git", ["add", "log", ".gitattributes", ".gitignore", "memlog.config.json"], { cwd: r });
      const staged = execFileSync("git", ["diff", "--cached", "--numstat", "--", "log"], { cwd: r }).toString();
      const added = staged.split("\n").filter(Boolean).reduce((n, l) => n + parseInt(l, 10), 0);
      const scopes = [...new Set(MemLog.open(r).events().map((e) => e.scope.split("/").slice(0, 2).join("/")))];
      const msg = opts.message ?? `memlog: ${added} events, scopes ${scopes.join(", ")}`;
      execFileSync("git", ["commit", "-q", "-m", msg], { cwd: r });
      process.stderr.write(`committed: ${msg}\n`);
    }),
  );

program
  .command("merge-driver <ours> <theirs>", { hidden: true })
  .description("git merge driver: union of lines, sorted by ULID")
  .action(
    run((ours: string, theirs: string) => {
      const read = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "");
      const lines = [...new Set([...read(ours), ...read(theirs)])];
      lines.sort((a, b) => {
        const ia = (JSON.parse(a) as MemEvent).id, ib = (JSON.parse(b) as MemEvent).id;
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
      fs.writeFileSync(ours, lines.join("\n") + (lines.length ? "\n" : ""));
    }),
  );

program.parse();

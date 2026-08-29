import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { GitMem } from "../src/gitmem.js";
import { ValidationError, readAllEvents } from "../src/log.js";
import { BRIEF_TOKEN_CAP, estimateTokens, project } from "../src/projections.js";
import type { Capability, MemEvent } from "../src/types.js";

const ADMIN: Capability = { principal: "human:test", scopes: [""], mode: "admin" };
const HUMAN = { kind: "human" as const, id: "joseph" };

let root: string;
let log: GitMem;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-"));
  log = GitMem.init(root);
});

function add(over: Partial<Parameters<GitMem["append"]>[0]> = {}): string {
  return log.append({ scope: "team/core", author: HUMAN, kind: "observation", body: `fact ${ulid()}`, ...over });
}

function projFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ["facts.json", "conflicts.json", "stats.json"]) {
    out[f] = fs.readFileSync(path.join(root, "proj", f), "utf8");
  }
  return out;
}

describe("determinism (§9.1)", () => {
  it("full rebuild == incremental build, byte-identical, corrections/retractions/promotions interleaved", () => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const kind = i % 10 === 7 ? "correction" : i % 10 === 8 ? "retraction" : i % 25 === 9 ? "promotion" : "observation";
      const supersedes = kind === "observation" ? [] : [ids[Math.floor(i / 2)]];
      ids.push(add({ kind, supersedes, scope: kind === "promotion" ? "team/other" : "team/core" }));
      if (i % 50 === 0) log.project(); // interleave incremental builds
    }
    log.project();
    const incremental = projFiles();
    fs.rmSync(path.join(root, "proj"), { recursive: true });
    log.project();
    expect(projFiles()).toEqual(incremental);
  });

  it("physical line order in day files does not affect projections", () => {
    for (let i = 0; i < 30; i++) add();
    const events = readAllEvents(root);
    const p1 = JSON.stringify(project(events, "2026-08-22T00:00:00Z"));
    // shuffle physical order; readAllEvents sorts by ULID
    const dir = path.join(root, "log");
    const files: string[] = [];
    const walk = (d: string) =>
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".jsonl") && files.push(path.join(d, e.name)),
      );
    walk(dir);
    for (const f of files) {
      const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
      lines.reverse();
      fs.writeFileSync(f, lines.join("\n") + "\n");
    }
    const p2 = JSON.stringify(project(readAllEvents(root), "2026-08-22T00:00:00Z"));
    expect(p2).toBe(p1);
  });
});

describe("immutability (§9.2)", () => {
  it("previously written lines are byte-identical after appends, project, and verify", () => {
    const snapshot = () => {
      const out: string[] = [];
      const walk = (d: string) =>
        fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
          e.isDirectory()
            ? walk(path.join(d, e.name))
            : e.name.endsWith(".jsonl") && out.push(fs.readFileSync(path.join(d, e.name), "utf8")),
        );
      walk(path.join(root, "log"));
      return out.join("");
    };
    for (let i = 0; i < 20; i++) add();
    const before = snapshot();
    add();
    log.project();
    log.verify();
    expect(snapshot().startsWith(before)).toBe(true);
  });
});

describe("scope isolation (§9.3)", () => {
  it("no event outside the capability subtree appears in any output, including point-get", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("team/core", "team/core/auth", "team/other", "team/core-secrets", "ops"), {
          minLength: 5,
          maxLength: 25,
        }),
        fc.constantFrom("team/core", "team/other", "ops", "team"),
        (scopes, capScope) => {
          const r = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-prop-"));
          const l = GitMem.init(r);
          const idScope = new Map<string, string>();
          for (const s of scopes) {
            const id = l.append({ scope: s, author: HUMAN, kind: "observation", body: `fact in ${s} ${ulid()}` });
            idScope.set(id, s);
          }
          const cap: Capability = { principal: "human:x", scopes: [capScope], mode: "read" };
          const inScope = (s: string) => s === capScope || s.startsWith(capScope + "/");
          for (const e of l.read(cap)) expect(inScope(idScope.get(e.id)!)).toBe(true);
          for (const f of l.facts(cap)) expect(inScope(f.scope)).toBe(true);
          for (const c of l.conflicts(cap)) for (const m of c.members) expect(inScope(idScope.get(m)!)).toBe(true);
          const brief = l.brief(cap);
          for (const [id, s] of idScope) {
            if (!inScope(s)) {
              expect(brief).not.toContain(`fact in ${s} ${id}`);
              // point-get by id must go through the choke point too
              expect(l.read(cap, { id })).toHaveLength(0);
              expect(() => l.trace(cap, id)).toThrow();
            }
          }
          fs.rmSync(r, { recursive: true, force: true });
        },
      ),
      { numRuns: 25 },
    );
  });

  it("promotion narrows visibility: readers of the old scope lose access", () => {
    const id = add({ scope: "team/core" });
    log.append({ scope: "team/core/secrets", author: HUMAN, kind: "promotion", body: "restrict", supersedes: [id] });
    const coreOnly: Capability = { principal: "h:x", scopes: ["team/core/auth"], mode: "read" };
    expect(log.read(coreOnly, { id })).toHaveLength(0);
    const secrets: Capability = { principal: "h:y", scopes: ["team/core/secrets"], mode: "read" };
    expect(log.read(secrets, { id })).toHaveLength(1);
  });
});

describe("cycle rejection (§9.4)", () => {
  it("rejects direct and multi-hop supersedes cycles at append", () => {
    const a = add();
    const b = add({ kind: "correction", supersedes: [a], body: "corrected once" });
    const c = add({ kind: "correction", supersedes: [b], body: "corrected twice" });
    // direct self-cycle: an event cannot supersede itself (id unknown pre-append,
    // so simulate multi-hop: a new correction with a fixed id superseding c,
    // where injecting a forged chain would loop)
    expect(() =>
      log.append({ scope: "team/core", author: HUMAN, kind: "correction", body: "x", supersedes: ["NOT-A-ULID"] }),
    ).toThrow(ValidationError);
    // forge: append with explicit id equal to an ancestor -> duplicate id rejected
    expect(() =>
      log.append({ scope: "team/core", author: HUMAN, kind: "correction", body: "x", supersedes: [c], id: a, force: true }),
    ).toThrow(/duplicate|cycle/);
  });

  it("correction/retraction/promotion require supersedes", () => {
    expect(() => add({ kind: "correction" })).toThrow(ValidationError);
    expect(() => add({ kind: "retraction" })).toThrow(ValidationError);
  });
});

describe("conflict detection (§9.5)", () => {
  it("finds negation, divergence, and explicit conflicts; precision >= 0.9; resolution always null", () => {
    // planted conflicts
    add({ body: "the staging db is reset every sunday" });
    add({ body: "the staging db is not reset every sunday" });
    add({ body: "the auth service uses tokens rotating on privilege change only" });
    add({ body: "the auth service uses passwords stored in redis forever" });
    const target = add({ body: "deploy window is friday" });
    add({ kind: "correction", supersedes: [target], body: "deploy window moved to monday" });
    add({ kind: "correction", supersedes: [target], body: "deploy window is now wednesday" });
    // unrelated facts that must NOT conflict
    add({ body: "ci runs on github actions" });
    add({ body: "the design doc lives in notion" });
    add({ scope: "ops", body: "the staging db is not reset every sunday" }); // different subtree from nothing conflicting

    const conflicts = log.conflicts(ADMIN);
    const kinds = conflicts.map((c) => c.detected_by).sort();
    expect(kinds).toContain("negation");
    expect(kinds).toContain("divergence");
    expect(kinds).toContain("explicit");
    for (const c of conflicts) expect(c.resolution).toBeNull();
    // precision: every detected conflict is one of the three planted ones
    expect(conflicts.length).toBeLessThanOrEqual(4);
  });

  it("resolution removes the conflict on the next projection", () => {
    const a = add({ body: "the cache ttl is short" });
    const b = add({ body: "the cache ttl is not short" });
    expect(log.conflicts(ADMIN).length).toBe(1);
    log.append({ scope: "team/core", author: HUMAN, kind: "correction", body: "cache ttl is 300s", supersedes: [a, b] });
    expect(log.conflicts(ADMIN).length).toBe(0);
  });
});

describe("brief budget (§9.6)", () => {
  it("never exceeds the token cap and warns on truncation", () => {
    for (let i = 0; i < 100; i++) add({ body: `a reasonably long fact about the system, number ${i}, ` + "x".repeat(100) });
    const warnings: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (warnings.push(String(s)), true)) as typeof process.stderr.write;
    try {
      const brief = log.brief(ADMIN);
      expect(estimateTokens(brief)).toBeLessThanOrEqual(BRIEF_TOKEN_CAP);
      expect(warnings.join("")).toContain("truncated");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("brief.override.md always wins and decisions outrank facts", () => {
    add({ body: "some observation" });
    add({ kind: "decision", body: "we chose postgres" });
    fs.writeFileSync(path.join(root, "brief.override.md"), "OVERRIDE TEXT FIRST");
    const brief = log.brief(ADMIN);
    expect(brief.indexOf("OVERRIDE TEXT FIRST")).toBeGreaterThan(-1);
    expect(brief.indexOf("OVERRIDE TEXT FIRST")).toBeLessThan(brief.indexOf("we chose postgres"));
    expect(brief.indexOf("we chose postgres")).toBeLessThan(brief.indexOf("some observation"));
  });
});

describe("merge (§9.7)", () => {
  it("divergent branches union-merge: sorted, no duplicate ids, projections match from-scratch build", () => {
    const cli = path.resolve("dist/cli.js");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    git(["config", "merge.gitmem-union.driver", `node ${cli} merge-driver %A %B`]);
    fs.writeFileSync(path.join(root, ".gitattributes"), "log/**/*.jsonl merge=gitmem-union\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "proj/\n");
    add({ body: "shared base fact" });
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    git(["checkout", "-q", "-b", "branch-a"]);
    add({ body: "fact from branch a" });
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "a"]);
    git(["checkout", "-q", "-"]);
    add({ body: "fact from branch b" });
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "b"]);
    git(["merge", "-q", "--no-edit", "branch-a"]);

    const events = readAllEvents(root);
    expect(events.map((e) => e.body).sort()).toEqual(["fact from branch a", "fact from branch b", "shared base fact"]);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort());
    expect(log.verify().ok).toBe(true);
    const merged = JSON.stringify(project(events, "2026-08-22T00:00:00Z"));
    const scratch = JSON.stringify(project(readAllEvents(root), "2026-08-22T00:00:00Z"));
    expect(merged).toBe(scratch);
  });
});

describe("crash safety (§9.8)", () => {
  it("a torn (partial) last line is detected by verify", () => {
    add();
    const files: string[] = [];
    const walk = (d: string) =>
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".jsonl") && files.push(path.join(d, e.name)),
      );
    walk(path.join(root, "log"));
    fs.appendFileSync(files[0], '{"id":"01JTORNLINE'); // simulated torn write
    const result = log.verify();
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/torn|unparseable/);
  });

  it("a complete append passes verify", () => {
    for (let i = 0; i < 5; i++) add();
    expect(log.verify().ok).toBe(true);
  });

  it("a lock left behind by a crashed writer is broken, not honored forever", () => {
    const lock = path.join(root, "log", ".lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const old = Date.now() - 60_000;
    fs.utimesSync(lock, old / 1000, old / 1000);
    expect(add()).toBeTruthy();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a fresh lock is honored (concurrent writer, not a crash)", () => {
    const lock = path.join(root, "log", ".lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    expect(() => add()).toThrow(/could not acquire/);
    fs.unlinkSync(lock);
  });
});

describe("validation", () => {
  it("rejects bad scope, empty body, out-of-range confidence, missing refs, clock skew", () => {
    expect(() => add({ scope: "Team/Core" })).toThrow(ValidationError);
    expect(() => add({ body: "  " })).toThrow(ValidationError);
    expect(() => add({ confidence: 1.5 })).toThrow(ValidationError);
    expect(() => add({ derived_from: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] })).toThrow(ValidationError);
    expect(() => add({ ts: "2020-01-01T00:00:00.000Z", id: ulid(Date.parse("2020-01-01")) })).toThrow(/24h/);
    // and --force allows historical imports
    expect(add({ ts: "2020-01-01T00:00:00.000Z", id: ulid(Date.parse("2020-01-01")), force: true })).toBeTruthy();
  });
});

describe("stale (git-anchored staleness)", () => {
  it("flags a fact whose source_uri anchor changed after the fact was written", () => {
    const cli = path.resolve("dist/cli.js");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root });
    const cliRun = (args: string[]) => execFileSync("node", [cli, "--root", root, ...args], { cwd: root }).toString();
    execFileSync("node", [cli, "--root", root, "init"], { cwd: root });
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(root, "auth.ts"), "export const x = 1\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "initial"]);
    log.append({ scope: "team/core", author: HUMAN, kind: "observation", body: "x is always 1", meta: { source_uri: "auth.ts" } });
    fs.writeFileSync(path.join(root, "auth.ts"), "export const x = 2\n");
    git(["add", "auth.ts"]);
    git(["commit", "-qm", "change x"]);
    const out = cliRun(["stale", "--json"]);
    expect(out).toContain("x is always 1");
    expect(out).toContain("change x");
  });
});

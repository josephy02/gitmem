// generates demo/events.ndjson: ~50 events, 3 scopes, 2 corrections, 1 retraction, 1 promotion, 1 live conflict
import { ulid } from "ulid";
import * as fs from "node:fs";

const start = Date.parse("2026-08-01T09:00:00Z");
let i = 0;
const lines = [];
const ids = [];
function ev(over) {
  const ts = new Date(start + i * 3600_000).toISOString();
  const e = {
    id: ulid(start + i * 3600_000),
    ts,
    scope: "team/core",
    author: { kind: "agent", id: "builder-3", session: "s-" + Math.ceil((i + 1) / 10) },
    kind: "observation",
    body: "",
    derived_from: [],
    supersedes: [],
    confidence: 0.8,
    ...over,
  };
  i++;
  ids.push(e.id);
  lines.push(JSON.stringify(e));
  return e.id;
}
const human = { kind: "human", id: "joseph" };

const bodies = {
  "team/core": [
    "the staging db is reset every sunday 03:00 utc",
    "ci runs on github actions with a 15 minute budget",
    "the design doc for q3 lives in notion under core/plans",
    "error budgets are tracked per service in grafana",
    "the monorepo uses pnpm workspaces",
    "feature flags are served from configcat",
    "the on-call rotation changes tuesdays",
    "release trains cut every other thursday",
    "the api gateway rate limit is 600 rpm per key",
    "postgres 16 is the standard database version",
    "all services log in json to stdout",
    "the artifact registry is ghcr.io",
    "load tests run nightly against staging",
    "the payments sandbox uses stripe test mode",
    "search infra is opensearch 2.x",
  ],
  "team/core/auth": [
    "mobile still depends on the old auth module; do not refactor",
    "session tokens rotate on privilege change, not on a timer",
    "the oauth callback allowlist is managed in terraform",
    "password hashing uses argon2id",
    "mfa enrollment is optional for internal users",
    "the jwt clock skew tolerance is 30 seconds",
    "refresh tokens are single-use",
    "service-to-service auth uses mtls",
    "the login page a/b test ends august 30",
    "auth service deploys are pinned to us-east-1",
  ],
  "team/platform": [
    "kubernetes clusters upgrade quarterly",
    "the terraform state bucket is versioned",
    "vault leases default to 24 hours",
    "spot instances are used for batch jobs only",
    "the cdn is cloudfront with 5 minute default ttl",
    "internal dns lives under .corp.example",
    "grafana dashboards are provisioned from git",
    "node pools autoscale between 3 and 40 nodes",
    "the backup retention policy is 35 days",
    "prometheus retention is 15 days",
  ],
};

const scopeIds = {};
for (const [scope, list] of Object.entries(bodies)) {
  scopeIds[scope] = list.map((body, j) =>
    ev({ scope, body, author: j % 3 === 2 ? human : { kind: "agent", id: "builder-3" }, confidence: j % 3 === 2 ? 1.0 : 0.8 }),
  );
}

// decisions
const d1 = ev({ kind: "decision", body: "we standardize on postgres for all new services", author: human, confidence: 1.0 });
ev({ kind: "decision", scope: "team/core/auth", body: "auth rewrite is deferred until mobile drops the legacy module", author: human, confidence: 1.0, derived_from: [scopeIds["team/core/auth"][0]] });
ev({ kind: "decision", scope: "team/platform", body: "batch workloads move to karpenter in q4", author: human, confidence: 1.0 });

// 2 corrections
ev({ kind: "correction", body: "the staging db is reset every saturday 03:00 utc, moved from sunday", supersedes: [scopeIds["team/core"][0]], author: human, confidence: 1.0 });
ev({ kind: "correction", scope: "team/core/auth", body: "the jwt clock skew tolerance is 60 seconds as of the august rollout", supersedes: [scopeIds["team/core/auth"][5]], author: human, confidence: 1.0 });

// 1 retraction
ev({ kind: "retraction", scope: "team/core/auth", body: "the login page a/b test was cancelled", supersedes: [scopeIds["team/core/auth"][8]], author: human, confidence: 1.0 });

// 1 promotion
ev({ kind: "promotion", scope: "team", body: "shared with the whole team", supersedes: [d1], author: human, confidence: 1.0 });

// 1 live conflict (negation pair, both live)
ev({ scope: "team/platform", body: "spot instances are not used for batch jobs only", author: { kind: "agent", id: "builder-7" } });

// derived observations
ev({ body: "nightly load tests currently fail against the payments sandbox", derived_from: [scopeIds["team/core"][12], scopeIds["team/core"][13]] });
ev({ scope: "team/platform", body: "cdn ttl raised to 15 minutes for the static bucket", derived_from: [scopeIds["team/platform"][4]], ttl_hint: "2026-12-01T00:00:00Z" });

fs.writeFileSync("demo/events.ndjson", lines.join("\n") + "\n");
console.log(lines.length + " events");

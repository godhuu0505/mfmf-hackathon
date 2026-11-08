import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentBaseline } from "../../scripts/ci/deployment-baseline.mjs";
import { selectChanges, SUITES } from "../../scripts/ci/changed-suites.mjs";
const env = { GITHUB_REPOSITORY: "godhuu0505/mfmf", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "300", GITHUB_TOKEN: "fixture-token" };
const run = id => ({ id, run_attempt: 1, repository: { full_name: env.GITHUB_REPOSITORY }, head_repository: { full_name: env.GITHUB_REPOSITORY }, path: ".github/workflows/deploy-production.yml", event: "push", head_branch: "main", head_sha: "a".repeat(40), status: "completed", conclusion: "success" });
const job = (id, conclusion = "success", completed = "2026-11-01T00:00:00Z") => ({
  name: "Cloud Run Production (opt-in)", run_id: id, status: "completed", conclusion,
  started_at: completed, completed_at: completed,
  steps: [{ name: "Build, stage and promote existing Cloud Run service", status: "completed", conclusion,
    started_at: completed, completed_at: completed }],
});
test("actual completion order handles reruns; failed or cancelled latest builds block retry", async () => {
  for (const conclusion of ["success", "failure", "cancelled"]) {
    const result = deploymentBaseline(env, async url => {
      if (url.includes("/workflows/")) return Response.json({ total_count: 2, workflow_runs: [run(200), { ...run(199), head_sha: "b".repeat(40), run_attempt: 2 }] });
      const id = url.includes("/200/") ? 200 : 199;
      if (url.includes("/199/attempts/1/")) return Response.json({ total_count: 1, jobs: [job(199, "success", "2026-10-31T00:00:00Z")] });
      return Response.json({ total_count: 1, jobs: [job(id, id === 200 ? "success" : conclusion, id === 200 ? "2026-11-01T00:00:00Z" : "2026-11-02T00:00:00Z")] });
    });
    if (conclusion === "success") assert.equal((await result).sha, "b".repeat(40));
    else await assert.rejects(() => result, /Latest actual deployment/);
  }
});
test("pre-build gate failures are not paid deployment attempts", async () => {
  const result = await deploymentBaseline(env, async url => {
    if (url.includes("/workflows/")) return Response.json({ total_count: 2, workflow_runs: [run(200), run(199)] });
    const id = url.includes("/200/") ? 200 : 199, value = job(id, id === 200 ? "failure" : "success");
    if (id === 200) { value.steps[0].conclusion = "skipped"; value.steps[0].started_at = null; }
    return Response.json({ total_count: 1, jobs: [value] });
  });
  assert.equal(result.run_id, "199");
});
test("earlier attempts remain deployment proof when a later attempt stopped before build", async () => {
  const result = await deploymentBaseline(env, async url => {
    if (url.includes("/workflows/")) return Response.json({ total_count: 2, workflow_runs: [run(200), { ...run(199), head_sha: "b".repeat(40), run_attempt: 2 }] });
    const id = Number(url.split("/runs/")[1].split("/")[0]), value = job(id, "success", id === 200 ? "2026-11-01T00:00:00Z" : "2026-11-02T00:00:00Z");
    if (url.includes("/199/attempts/2/")) { value.conclusion = "failure"; value.steps[0].conclusion = "skipped"; value.steps[0].started_at = null; }
    return Response.json({ total_count: 1, jobs: [value] });
  });
  assert.equal(result.sha, "b".repeat(40));
});
test("a current-run retry cannot hide the prior uncertain paid attempt", async () => {
  await assert.rejects(() => deploymentBaseline({ ...env, GITHUB_RUN_ID: "200", GITHUB_RUN_ATTEMPT: "2" }, async url => {
    if (url.includes("/workflows/")) return Response.json({ total_count: 2, workflow_runs: [{ ...run(200), run_attempt: 2 }, run(199)] });
    assert.ok(!url.includes("/200/attempts/2/"));
    const id = Number(url.split("/runs/")[1].split("/")[0]);
    return Response.json({ total_count: 1, jobs: [job(id, id === 200 ? "failure" : "success", id === 200 ? "2026-11-02T00:00:00Z" : "2026-11-01T00:00:00Z")] });
  }), /Latest actual deployment/);
});
test("pagination continues past a docs-only first page", async () => {
  let pages = 0;
  const result = await deploymentBaseline(env, async url => {
    if (url.includes("/workflows/")) { pages++; return Response.json({ total_count: 101, workflow_runs: url.endsWith("page=1") ? Array.from({ length: 100 }, (_, index) => run(200 - index)) : [run(100)] }); }
    const id = Number(url.split("/runs/")[1].split("/")[0]);
    return Response.json({ total_count: 1, jobs: [job(id, id === 100 ? "success" : "skipped")] });
  });
  assert.equal(pages, 2); assert.equal(result.run_id, "100");
});
test("only a successful actual Cloud Run job proves deployment, never docs-only success", async () => {
  const calls = [];
  const result = await deploymentBaseline(env, async (url, options) => {
    calls.push(url); assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    if (url.includes("/workflows/")) return Response.json({ total_count: 2, workflow_runs: [run(200), run(199)] });
    const id = url.includes("/200/") ? 200 : 199;
    return Response.json({ total_count: 1, jobs: [job(id, id === 200 ? "skipped" : "success")] });
  });
  assert.deepEqual(result, { known: true, sha: "a".repeat(40), run_id: "199" }); assert.equal(calls.length, 3);
});
test("incomplete, expired, ambiguous or foreign history cannot become a deployment baseline", async () => {
  for (const mutate of [value => { value.head_branch = "other"; }, value => { value.event = "pull_request"; }, value => { value.repository.full_name = "other/repo"; }, value => { value.path = ".github/workflows/other.yml"; }]) {
    const value = run(200); mutate(value);
    await assert.rejects(() => deploymentBaseline(env, async () => Response.json({ total_count: 1, workflow_runs: [value] })));
  }
  let calls = 0;
  await assert.rejects(() => deploymentBaseline(env, async url => {
    calls++;
    const page = url.includes("/workflows/") ? Number(new URL(url).searchParams.get("page")) : 1;
    return Response.json(url.includes("/workflows/") ? { total_count: 1001, workflow_runs: Array.from({ length: 100 }, (_, index) => run(10000 - page * 100 - index)) } : { total_count: 1, jobs: [job(200, "skipped")] });
  }));
  assert.equal(calls, 1010, "history beyond the bounded pagination must stop, never assume rollout is safe");
});
test("failed auth/DB changes remain selected across docs and later UI pushes", () => {
  const directory = mkdtempSync(join(tmpdir(), "mfmf-pending-ci-"));
  const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (path, value) => { mkdirSync(join(directory, path, ".."), { recursive: true }); writeFileSync(join(directory, path), value); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "synthetic source"]); return git(["rev-parse", "HEAD"]); };
  try {
    git(["init", "-q"]);
    const baseline = commit("README.md", "baseline");
    const auth = commit("src/lib/identity/allowlist.ts", "synthetic auth change");
    const docs = commit("README.md", "docs-only update");
    const ui = commit("src/components/RecordFilters.tsx", "synthetic UI change");
    const event = join(directory, "event.json");
    const select = (sha, before, baselineKnown = true) => { writeFileSync(event, JSON.stringify({ before })); return selectChanges({ ...env, GITHUB_SHA: sha, GITHUB_EVENT_PATH: event, DEPLOYMENT_BASELINE_SHA: baseline, DEPLOYMENT_BASELINE_KNOWN: String(baselineKnown) }, args => args[0] === "rev-parse" ? sha : git(args)); };
    const pendingUi = select(ui, docs); assert.ok(pendingUi.auth && pendingUi.database && pendingUi.mcp && pendingUi.deploy);
    const docsOnly = select(docs, auth); assert.equal(docsOnly.deploy, false); assert.equal(docsOnly.auth, false);
    const multiCommit = select(ui, baseline); assert.ok(multiCommit.auth && multiCommit.database);
    const unknown = select(ui, docs, false); assert.equal(unknown.deploy, false); assert.equal(unknown.deployment_blocked, true); assert.ok(SUITES.every(key => unknown[key]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("truncated final pages and duplicate run IDs cannot hide a later failed attempt", async () => {
  for (const list of [{ total_count: 2, workflow_runs: [run(200)] }, { total_count: 2, workflow_runs: [run(200), run(200)] }]) {
    await assert.rejects(() => deploymentBaseline(env, async url => Response.json(url.includes("/workflows/") ? list : { total_count: 1, jobs: [job(200)] })));
  }
});

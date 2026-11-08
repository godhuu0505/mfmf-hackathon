import { test } from "node:test";
import assert from "node:assert/strict";
import { requirePreflightContext, verifyCiRun, preflight } from "../../scripts/ci/production-preflight.mjs";
import { PROJECT, PROJECT_NUMBER, SERVICE_NAME, RUNTIME, IMAGE_BASE } from "../../scripts/gcp/production-config.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "godhuu0505/mfmf", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", CI_RUN_ID: "456", GITHUB_TOKEN: "github-fixture-token", GCP_PROJECT_ID: PROJECT, GCP_PROJECT_NUMBER: PROJECT_NUMBER, GCP_AUTH_ENABLED: "true", GCP_DEPLOY_ENABLED: "true", GCP_ACCESS_TOKEN: "fixture-token" };
const ciRun = () => ({ id: 456, path: ".github/workflows/ci.yml", event: "workflow_dispatch", head_branch: "main", head_sha: env.GITHUB_SHA, status: "completed", conclusion: "success", repository: { full_name: "godhuu0505/mfmf" }, head_repository: { full_name: "godhuu0505/mfmf" } });
const service = () => ({ name: SERVICE_NAME, terminalCondition: { state: "CONDITION_SUCCEEDED" }, latestReadyRevision: "ready", trafficStatuses: [{ revision: "ready", percent: 100 }], template: { serviceAccount: RUNTIME, containers: [{ image: IMAGE_BASE + "@sha256:" + "a".repeat(64), env: [{ name: "GCP_AUTH_ENABLED", value: "true" }, { name: "NEXT_PUBLIC_GCP_AUTH_ENABLED", value: "true" }, { name: "GOOGLE_LOGIN_ALLOWED_EMAILS", value: "fictional@example.com" }] }] } });
test("manual preflight verifies the exact CI run then makes one fixed cloud GET", async () => {
  const calls = [];
  assert.deepEqual(await preflight(env, async (url, options) => { calls.push([url, options.method]); assert.equal(options.redirect, "error"); return Response.json(url.startsWith("https://api.github.com/") ? ciRun() : service()); }), { authenticated: true, productionReadVerified: true, mutations: 0 });
  assert.deepEqual(calls, [["https://api.github.com/repos/godhuu0505/mfmf/actions/runs/456", "GET"], ["https://run.googleapis.com/v2/" + SERVICE_NAME, "GET"]]);
});
test("wrong event, branch, workflow, project or mode stops before cloud access", async () => {
  for (const [key, value] of [["GITHUB_EVENT_NAME", "push"], ["GITHUB_REF", "refs/heads/other"], ["GITHUB_WORKFLOW_REF", "other.yml"], ["GCP_PROJECT_ID", "other"], ["GCP_AUTH_ENABLED", "false"], ["GITHUB_SHA", "main"]]) {
    const changed = { ...env, [key]: value }; assert.throws(() => requirePreflightContext(changed));
    await assert.rejects(() => preflight(changed, () => { assert.fail("must not request"); }));
  }
  assert.doesNotThrow(() => requirePreflightContext({ ...env, GCP_DEPLOY_ENABLED: "false" }));
});
test("service drift and read rejection do not trigger repair or retry", async () => {
  for (const modify of [value => { value.template.serviceAccount = "other"; }, value => { value.trafficStatuses[0].percent = 50; }, value => { value.template.containers[0].image = IMAGE_BASE + ":latest"; }, value => { value.template.containers[0].env = []; }]) {
    const value = service(); modify(value); let calls = 0;
    await assert.rejects(() => preflight(env, async url => { calls++; return Response.json(url.startsWith("https://api.github.com/") ? ciRun() : value); })); assert.equal(calls, 2);
  }
});
test("failed, PR, foreign-workflow, foreign-repo or stale-SHA CI cannot authorize preflight", async () => {
  for (const change of [{ conclusion: "failure" }, { status: "in_progress" }, { event: "pull_request" }, { path: ".github/workflows/other.yml" }, { head_branch: "other" }, { head_sha: "b".repeat(40) }, { repository: { full_name: "other/repo" } }]) {
    let calls = 0;
    await assert.rejects(() => preflight(env, async url => { calls++; assert.ok(url.startsWith("https://api.github.com/")); return Response.json({ ...ciRun(), ...change }); }));
    assert.equal(calls, 1);
  }
  assert.equal(await verifyCiRun(env, async () => Response.json(ciRun())), true);
});

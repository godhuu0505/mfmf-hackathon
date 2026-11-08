import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { SUITES } from "../../scripts/ci/changed-suites.mjs";
const { parse } = createRequire(import.meta.url)("yaml");
const load = name => parse(readFileSync(new URL("../../.github/workflows/" + name, import.meta.url), "utf8"));
test("selected suites are gated by the same strict plan and cannot gain cloud permissions", () => {
  const ci = load("ci.yml");
  assert.deepEqual(ci.permissions, { contents: "read", actions: "read" });
  for (const suite of SUITES) {
    assert.equal(ci.jobs[suite].needs, "light");
    assert.equal(ci.jobs[suite].if, "needs.light.outputs." + suite + " == 'true'");
    assert.equal(ci.jobs[suite].environment, undefined);
    assert.equal(ci.jobs[suite].permissions, undefined);
  }
  assert.equal(ci.jobs.gate.if, "always()");
  assert.deepEqual(new Set(ci.jobs.gate.needs), new Set(["light", ...SUITES]));
});
test("production push requires the exact SHA gate; manual run has only GET preflight", () => {
  const deploy = load("deploy-production.yml");
  assert.equal(deploy.permissions.actions, "read", "reusable CI cannot elevate above caller permissions");
  assert.deepEqual(Object.keys(deploy.jobs).sort(), ["auth-preflight", "deploy-cloud-run", "verify"]);
  assert.equal(deploy.jobs.verify.if, "github.event_name == 'push'");
  const release = deploy.jobs["deploy-cloud-run"];
  assert.equal(release.needs, "verify");
  for (const condition of ["github.event_name == 'push'", "needs.verify.outputs.verified_sha == github.sha", "needs.verify.outputs.deploy_required == 'true'", "needs.verify.outputs.deployment_blocked == 'false'"]) assert.ok(release.if.includes(condition));
  assert.ok(deploy.jobs["auth-preflight"].if.includes("github.event_name == 'workflow_dispatch'"));
  assert.ok(deploy.jobs["auth-preflight"].if.includes("github.ref == 'refs/heads/main'"));
  assert.equal(deploy.jobs["auth-preflight"].permissions.actions, "read");
  assert.equal(deploy.on.workflow_dispatch.inputs.ci_run_id.required, true);
  assert.equal(deploy.jobs["auth-preflight"].env.CI_RUN_ID, "${{ inputs.ci_run_id }}");
  assert.equal(release.environment, undefined);
  const text = readFileSync(new URL("../../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
  assert.doesNotMatch(text, /secrets\.|VERCEL|SUPABASE_ACCESS_TOKEN|production\s*\n\s*name:/);
  const steps = deploy.jobs["auth-preflight"].steps;
  assert.equal(steps.filter(step => step.run?.includes("production-preflight.mjs")).length, 2);
  assert.ok(steps.every(step => !step.run || !/(?:deploy-existing|docker|:run|db push)/.test(step.run)));
});
test("legacy operations and cron cannot use ignored environment protection in private Free", () => {
  for (const file of readdirSync(new URL("../../.github/workflows/", import.meta.url))) {
    if (["ci.yml", "deploy-production.yml"].includes(file)) continue;
    const workflow = load(file);
    assert.equal(workflow.on.schedule, undefined, file);
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(job.if.includes("vars.LEGACY_OPERATIONS_ENABLED == 'true'"), file);
      assert.ok(job.if.includes("github.event.repository.private == false"), file);
    }
  }
});

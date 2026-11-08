import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChanges, runtimePackageChanged, selectChanges, SUITES } from "../../scripts/ci/changed-suites.mjs";
import { assertGate } from "../../scripts/ci/assert-gate.mjs";

test("ordinary UI keeps heavy suites local; docs/pipeline do not deploy", () => {
  const ui = classifyChanges(["src/components/RecordFilters.tsx", "public/icons/icon-192.png"]);
  assert.equal(ui.deploy, true); assert.ok(SUITES.every(key => !ui[key]));
  assert.equal(classifyChanges(["README.md", "docs/guides/deploy.md"]).deploy, false);
  const pipeline = classifyChanges([".github/workflows/deploy-production.yml", "scripts/ci/changed-suites.mjs", "scripts/gcp/wif-policy.sh"]);
  assert.equal(pipeline.deploy, false); assert.ok(SUITES.every(key => pipeline[key]));
});
test("identity, tenant actions, DB and operator select real isolation checks", () => {
  for (const path of ["src/lib/identity/allowlist.ts", "src/app/auth/identity/session/route.ts", "src/lib/mcp/store.ts", "src/lib/supabase/server.ts", "src/lib/gcp/dataClient.ts", "src/lib/household.ts", "src/app/(app)/records/actions.ts", "src/app/(app)/records/related-actions.ts", "src/app/api/feedback/export/route.ts", "src/lib/signup.ts", "src/lib/googleCrypto.ts", "src/app/login/page.tsx", "src/app/login/LoginForm.tsx", "src/app/signup/page.tsx", "src/app/forgot-password/page.tsx", "src/app/reset-password/ResetPasswordForm.tsx", "src/app/(app)/page.tsx", "src/app/(app)/layout.tsx", "src/app/onboarding/page.tsx", "src/app/new-server-boundary/page.tsx"]) {
    const plan = classifyChanges([path]); assert.ok(plan.database && plan.supabase && plan.auth && plan.mcp && plan.deploy, path);
  }
  for (const path of ["db/gcp/migrations/20261108000000_test.sql", "supabase/tests/household.sql", "scripts/gcp/database-operator.mjs"]) assert.equal(classifyChanges([path]).database, true);
});
test("unknown or renamed-sensitive paths cannot reduce coverage", () => {
  for (const paths of [null, ["new-runtime.config"], ["../outside"], ["Dockerfile.cloudrun"], ["package-lock.json"], ["src/lib/newTenantGuard.ts"], ["src/server/new-policy.ts"], ["src/components/NewServerComponent.tsx"], ["src/components/AppHeader.tsx"], ["public/sw.js"]]) assert.ok(SUITES.every(key => classifyChanges(paths)[key]));
  assert.equal(classifyChanges(["src/lib/identity/allowlist.ts", "docs/old-allowlist.ts"]).auth, true);
  for (const paths of [["src/lib/identity/allowlist.ts", "src/lib/newTenantGuard.ts"], ["src/lib/newTenantGuard.ts", "src/lib/identity/allowlist.ts"]]) assert.ok(SUITES.every(key => classifyChanges(paths)[key]), paths.join(","));
});
test("a successfully read empty diff cannot initiate a paid build", () => {
  const plan = classifyChanges([]);
  assert.equal(plan.known, true); assert.equal(plan.deploy, false); assert.ok(SUITES.every(key => !plan[key]));
});
test("suite selection is independent of changed-path order, including mixed unknown sources", () => {
  const paths = ["README.md", "src/components/RecordFilters.tsx", "src/lib/identity/allowlist.ts", "src/lib/newTenantGuard.ts", ".github/workflows/ci.yml", "public/sw.js", "package.json"];
  const decision = input => {
    const plan = classifyChanges(input, { packageRuntimeChanged: false });
    return Object.fromEntries(["known", "deploy", "deployment_blocked", ...SUITES].map(key => [key, plan[key]]));
  };
  for (const a of paths) for (const b of paths.filter(path => path !== a)) for (const c of paths.filter(path => path !== a && path !== b)) {
    assert.deepEqual(decision([a, b, c]), decision([a, b, c].sort()), [a, b, c].join(","));
  }
});
test("only test/check/lint script metadata is exempt from runtime changes", () => {
  const before = JSON.stringify({ dependencies: { next: "15" }, scripts: { build: "next build", test: "vitest" } });
  const after = JSON.stringify({ scripts: { build: "next build", test: "vitest run", "check:local": "node scripts/ci/local-check.mjs" }, dependencies: { next: "15" } });
  assert.equal(runtimePackageChanged(before, after), false);
  assert.equal(classifyChanges(["package.json"], { packageRuntimeChanged: false }).deploy, false);
  assert.equal(runtimePackageChanged(before, after.replace("next build", "other-build")), true);
  assert.equal(runtimePackageChanged(before, after.replace('"15"', '"16"')), true);
});
test("unavailable history selects everything; mismatched checkout stops", () => {
  const sha = "a".repeat(40), directory = mkdtempSync(join(tmpdir(), "mfmf-ci-event-"));
  try {
    const file = join(directory, "event.json"); writeFileSync(file, JSON.stringify({ before: "b".repeat(40) }));
    const env = { GITHUB_SHA: sha, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: file };
    const plan = selectChanges(env, args => { if (args[0] === "rev-parse") return sha; throw new Error("missing history"); });
    assert.equal(plan.known, false); assert.equal(plan.deploy, false); assert.equal(plan.deployment_blocked, true); assert.ok(SUITES.every(key => plan[key]));
    assert.throws(() => selectChanges(env, () => "b".repeat(40)), /Checkout/);
  } finally { rmSync(directory, { recursive: true }); }
});
test("aggregate requires successful selected suites and skipped unselected suites", () => {
  const sha = "a".repeat(40), plan = classifyChanges(["README.md"]);
  const needs = { light: { result: "success", outputs: Object.fromEntries(Object.entries({ ...plan, source_sha: sha }).map(([key, value]) => [key, String(value)])) }, ...Object.fromEntries(SUITES.map(key => [key, { result: "skipped" }])) };
  assert.deepEqual(assertGate(needs, sha), { verified_sha: sha, deploy_required: "false", deployment_blocked: "false" });
  for (const result of ["failure", "cancelled", "success", undefined]) { const changed = structuredClone(needs); changed.database.result = result; assert.throws(() => assertGate(changed, sha)); }
  for (const result of ["skipped", "cancelled", "failure"]) { const changed = structuredClone(needs); changed.light.outputs.database = "true"; changed.database.result = result; assert.throws(() => assertGate(changed, sha)); }
  const changed = structuredClone(needs); changed.light.outputs.database = "true"; changed.database.result = "success"; assert.doesNotThrow(() => assertGate(changed, sha));
  changed.light.outputs.source_sha = "b".repeat(40); assert.throws(() => assertGate(changed, sha));
  const unknown = structuredClone(needs); unknown.light.outputs.known = "false"; assert.throws(() => assertGate(unknown, sha));
  const blocked = structuredClone(needs); blocked.light.outputs.deployment_blocked = "true"; assert.throws(() => assertGate(blocked, sha, "push"), /CD blocked/);
});

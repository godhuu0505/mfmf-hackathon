import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SUITES } from "./changed-suites.mjs";

export function assertGate(needs, sha, event = "pull_request") {
  const plan = needs?.light?.outputs;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || needs?.light?.result !== "success" || plan?.source_sha !== sha ||
      !["true", "false"].includes(plan.deploy) || !["true", "false"].includes(plan.known) || !["true", "false"].includes(plan.deployment_blocked)) throw new Error("Light CI or exact-SHA selection failed.");
  if (plan.known === "false" && SUITES.some(suite => plan[suite] !== "true")) throw new Error("An unknown diff must select every suite.");
  if (plan.deployment_blocked === "true" && (plan.deploy !== "false" || event === "push")) throw new Error("CD blocked: deployment source/history is unknown; verify evidence and costs before release.");
  for (const suite of SUITES) {
    if (!["true", "false"].includes(plan[suite])) throw new Error("Missing suite decision: " + suite);
    if (needs[suite]?.result !== (plan[suite] === "true" ? "success" : "skipped")) throw new Error("CI result mismatch: " + suite);
  }
  return { verified_sha: sha, deploy_required: plan.deploy, deployment_blocked: plan.deployment_blocked };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = assertGate(JSON.parse(process.env.CI_NEEDS), process.env.GITHUB_SHA, process.env.GITHUB_EVENT_NAME);
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => key + "=" + value).join("\n") + "\n");
  console.log("Required CI checks passed for the exact event SHA.");
}

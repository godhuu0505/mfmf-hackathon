import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const REPO = "godhuu0505/mfmf";
const ROOT = "https://api.github.com/repos/" + REPO;

// Successful workflow runs with a skipped deployment are not deployment proof.
// A bounded search that cannot prove a source SHA must block CD, never guess.
export async function deploymentBaseline(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN || env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "push") throw new Error("Fixed main push context required.");
  let requests = 0;
  const get = async path => {
    if (++requests > 1200) throw new Error("Deployment proof exceeds the bounded API budget.");
    const response = await fetchImpl(ROOT + path, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok) throw new Error("Deployment history unavailable.");
    const parts = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 4 * 1024 * 1024) throw new Error("History too large."); parts.push(Buffer.from(part)); }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  };
  let latest, totalCount, complete = false;
  const seenRuns = new Set();
  for (let page = 1; page <= 10; page++) {
    const list = await get("/actions/workflows/deploy-production.yml/runs?branch=main&event=push&per_page=100&page=" + page);
    if (!Array.isArray(list.workflow_runs) || list.workflow_runs.length > 100 || !Number.isInteger(list.total_count)) throw new Error("Invalid run history.");
    totalCount ??= list.total_count;
    if (list.total_count !== totalCount || list.workflow_runs.length !== Math.min(100, totalCount - (page - 1) * 100)) throw new Error("Incomplete or changing run pagination.");
    for (const run of list.workflow_runs) {
      if (seenRuns.has(String(run.id))) throw new Error("Duplicated run history.");
      seenRuns.add(String(run.id));
      if (!/^[1-9][0-9]{0,19}$/.test(String(run.id)) || !/^[1-9][0-9]{0,5}$/.test(String(run.run_attempt)) ||
          run.repository?.full_name !== REPO || run.head_repository?.full_name !== REPO || run.head_branch !== "main" ||
          run.event !== "push" || run.path !== ".github/workflows/deploy-production.yml" ||
          !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")) throw new Error("Unexpected deployment history.");
      for (let attempt = Number(run.run_attempt); attempt >= 1; attempt--) {
        if (String(run.id) === env.GITHUB_RUN_ID && String(attempt) === env.GITHUB_RUN_ATTEMPT) continue;
        const jobs = await get("/actions/runs/" + run.id + "/attempts/" + attempt + "/jobs?per_page=100");
        if (!Array.isArray(jobs.jobs) || !Number.isInteger(jobs.total_count) || jobs.total_count !== jobs.jobs.length || jobs.total_count > 100) throw new Error("Incomplete deployment job history.");
        const deployed = jobs.jobs.filter(job => ["Cloud Run Production", "Cloud Run Production (opt-in)"].includes(job.name));
        if (deployed.length > 1) throw new Error("Ambiguous deployment proof.");
        if (!deployed.length || deployed[0].conclusion === "skipped") continue;
        const job = deployed[0];
        if (String(job.run_id) !== String(run.id)) throw new Error("Foreign deployment job.");
        const build = job.steps?.find(step => ["Build, stage and promote existing Cloud Run service", "Build, verify backup jobs, upgrade, stage, probe and promote"].includes(step.name));
        // A failed CI/auth gate whose build step never started is not a paid attempt.
        if (build && (build.conclusion === "skipped" || build.status === "queued" || !build.started_at)) continue;
        const timestamp = job.completed_at ?? build?.completed_at ?? build?.started_at ?? job.started_at;
        if (!/^\d{4}-\d\d-\d\dT[^\s]+Z$/.test(timestamp ?? "") || !Number.isFinite(Date.parse(timestamp))) throw new Error("Deployment timing unavailable.");
        const candidate = { sha: run.head_sha, run_id: String(run.id), attempt, time: Date.parse(timestamp),
          proved: Boolean(build && job.status === "completed" && job.conclusion === "success" && build.status === "completed" && build.conclusion === "success") };
        if (latest?.time === candidate.time && (latest.sha !== candidate.sha || latest.run_id !== candidate.run_id || latest.attempt !== candidate.attempt)) throw new Error("Ambiguous deployment order.");
        if (!latest || candidate.time > latest.time) latest = candidate;
      }
    }
    if (page * 100 >= list.total_count) { complete = true; break; }
    if (list.workflow_runs.length !== 100) throw new Error("Incomplete run pagination.");
  }
  if (!complete || !latest?.proved) throw new Error("Latest actual deployment is failed, unknown, or outside the bounded history.");
  return { known: true, sha: latest.sha, run_id: latest.run_id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = await deploymentBaseline(process.env); }
  catch { result = { known: false, sha: "", run_id: "" }; }
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => key + "=" + value).join("\n") + "\n");
  console.log(result.known ? "Verified latest actual Cloud Run deployment source." : "Deployment source could not be proved; all checks required and CD blocked.");
}

import { pathToFileURL } from "node:url";
import { PROJECT, PROJECT_NUMBER, SERVICE_NAME, RUNTIME, IMAGE_BASE } from "../gcp/production-config.mjs";

export function requirePreflightContext(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "godhuu0505/mfmf" ||
      env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_WORKFLOW_REF !== "godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main" ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") || env.GCP_PROJECT_ID !== PROJECT ||
      !/^[1-9][0-9]{0,19}$/.test(env.CI_RUN_ID ?? "") ||
      env.GCP_PROJECT_NUMBER !== PROJECT_NUMBER || env.GCP_AUTH_ENABLED !== "true") {
    throw new Error("Read-only preflight requires the fixed production main manual context.");
  }
}

async function boundedJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error("Read-only API access rejected; response withheld."); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 1048576) throw new Error("Unexpected response size."); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function verifyCiRun(env, fetchImpl = fetch) {
  requirePreflightContext(env);
  if (!env.GITHUB_TOKEN || /[\s\x00-\x1f]/.test(env.GITHUB_TOKEN)) throw new Error("GitHub read token missing.");
  const run = await boundedJson(await fetchImpl("https://api.github.com/repos/godhuu0505/mfmf/actions/runs/" + env.CI_RUN_ID, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  }));
  if (String(run.id) !== env.CI_RUN_ID || run.path !== ".github/workflows/ci.yml" || run.event !== "workflow_dispatch" ||
      run.head_branch !== "main" || run.head_sha !== env.GITHUB_SHA || run.status !== "completed" || run.conclusion !== "success" ||
      run.repository?.full_name !== "godhuu0505/mfmf" || run.head_repository?.full_name !== "godhuu0505/mfmf") {
    throw new Error("A successful manual main CI run for the exact SHA is required.");
  }
  return true;
}

export async function preflight(env, fetchImpl = fetch) {
  await verifyCiRun(env, fetchImpl);
  if (!env.GCP_ACCESS_TOKEN || /[\s\x00-\x1f]/.test(env.GCP_ACCESS_TOKEN)) throw new Error("Short-lived token missing.");
  const response = await fetchImpl("https://run.googleapis.com/v2/" + SERVICE_NAME, {
    method: "GET", headers: { Authorization: "Bearer " + env.GCP_ACCESS_TOKEN }, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  const service = await boundedJson(response);
  const container = service.template?.containers?.[0];
  const values = new Map((container?.env ?? []).map(item => [item.name, item.value]));
  const rows = service.trafficStatuses;
  if (service.name !== SERVICE_NAME || service.template?.serviceAccount !== RUNTIME || service.template?.containers?.length !== 1 ||
      typeof container.image !== "string" || !container.image.startsWith(IMAGE_BASE + "@sha256:") ||
      !/^[a-f0-9]{64}$/.test(container.image.slice((IMAGE_BASE + "@sha256:").length)) ||
      service.reconciling === true || service.terminalCondition?.state !== "CONDITION_SUCCEEDED" ||
      !Array.isArray(rows) || rows.length !== 1 || rows[0].percent !== 100 || rows[0].tag ||
      !service.latestReadyRevision || rows[0].revision?.split("/").pop() !== service.latestReadyRevision.split("/").pop() ||
      values.get("GCP_AUTH_ENABLED") !== "true" || values.get("NEXT_PUBLIC_GCP_AUTH_ENABLED") !== "true" ||
      !values.get("GOOGLE_LOGIN_ALLOWED_EMAILS")) throw new Error("Fixed production service checks failed; values withheld.");
  return { authenticated: true, productionReadVerified: true, mutations: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--validate-context") { requirePreflightContext(process.env); console.log("Fixed manual context verified; no cloud request made."); }
    else if (process.argv[2] === "--validate-ci") { await verifyCiRun(process.env); console.log("Successful manual main CI verified for the exact SHA; no cloud request made."); }
    else console.log(JSON.stringify(await preflight(process.env)));
  } catch { console.error("Read-only production preflight failed; credentials and API details withheld."); process.exitCode = 1; }
}

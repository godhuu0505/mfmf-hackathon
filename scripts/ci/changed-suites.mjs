import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SUITES = ["database", "supabase", "auth", "container", "mcp", "e2e"];
const all = (reason, blocked = false) => ({ known: false, deploy: !blocked, deployment_blocked: blocked, reason, ...Object.fromEntries(SUITES.map(key => [key, true])) });
const documentation = path => /^(docs\/|proto\/|(?:README|AGENTS|CLAUDE|LICENSE|CONTRIBUTING)(?:\.[^/]*)?$)/.test(path);
const pipeline = path => /^(\.github\/|\.claude\/|scripts\/ci\/|tests\/|justfile$|(?:vitest|playwright)[^/]*\.[^/]+$|firebase\.mcp\.json$|\.gitignore$)/.test(path);
const nonRuntimeScripts = /^(?:check(?::.*)?|test(?::.*)?|lint|typecheck)$/;
// Reviewed presentation/client files only. New source locations fail closed.
const presentation = new Set(["AppTabBar", "CareSummaryCopyButton", "CareSummaryPrintButton", "CareSummaryRangePreset", "CopyLinkButton", "CreateSheet", "FeedbackWidget", "FormConfirm", "HideOnFormRoute", "PageSkeleton", "PetEditSheet", "PhotoGallery", "RecordActionsSheet", "RecordFilters", "RecordForm", "ScheduleCalendar", "ScheduleRuleRow", "SourceIcon", "SubmitButton", "TagInput", "TodayPlanCard", "UserAvatar", "WeightChart"].map(name => "src/components/" + name + ".tsx"));

export function runtimePackageChanged(before, after) {
  const normalize = text => {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid package manifest");
    value.scripts = Object.fromEntries(Object.entries(value.scripts ?? {}).filter(([key]) => !nonRuntimeScripts.test(key)));
    const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
    return JSON.stringify(stable(value));
  };
  return normalize(before) !== normalize(after);
}

export function classifyChanges(paths, { packageRuntimeChanged = true } = {}) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes(".."))) return all("unknown-diff");
  const result = { known: true, deploy: false, deployment_blocked: false, reason: "changed-paths", ...Object.fromEntries(SUITES.map(key => [key, false])) };
  if (!paths.length) return { ...result, reason: "no-source-change" };
  for (const path of paths) {
    if (documentation(path) || (path === "package.json" && !packageRuntimeChanged)) continue;
    if (/^(package(?:-lock)?\.json|Dockerfile[^/]*|\.dockerignore|(?:next|postcss|tailwind|tsconfig)[^/]*\.[^/]+|\.npmrc)$/.test(path)) {
      result.deploy = true; for (const suite of SUITES) result[suite] = true; continue;
    }
    // A changed selector/workflow must not silently turn off its own checks.
    if (/^(\.github\/|scripts\/ci\/|tests\/ci\/|scripts\/gcp\/(?:wif-policy\.sh|enable-production-wif\.sh|grant-deploy-access\.sh)$)/.test(path)) {
      for (const suite of SUITES) result[suite] = true; continue;
    }
    if (/^(db\/|supabase\/|tests\/gcp\/|tests\/integration\/)/.test(path)) {
      result.database = result.supabase = true; result.deploy ||= !path.startsWith("tests/"); continue;
    }
    if (/^src\//.test(path)) {
      result.deploy = true;
      const securitySource = /(?:^|\/)(?:identity|auth|oauth|mcp|supabase|gcp|login|signup|forgot-password|reset-password)(?:\/|\.)|\/middleware\.|\/household[^/]*\.|\/(?:[^/]*actions|route|page|layout|template)\.[cm]?[jt]sx?$|\/[^/]*(?:signup|session|cookie|csrf|crypto|allowlist)[^/]*\.[cm]?[jt]sx?$/i.test(path);
      const dataSource = /^src\/lib\/(?:media|gcs|storage)|^src\/types\//.test(path);
      if (securitySource) result.database = result.supabase = result.auth = result.mcp = true;
      if (dataSource) result.database = result.supabase = result.auth = true;
      if (securitySource || dataSource || presentation.has(path) || /^src\/app\/.*\.(?:css|svg|png|ico)$/.test(path)) continue;
      return all("unclassified-source");
    }
    if (/^scripts\/gcp\//.test(path)) { result.deploy = result.database = result.supabase = result.auth = result.container = result.mcp = true; continue; }
    if (/^public\//.test(path)) {
      if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico|webmanifest)$/.test(path)) { result.deploy = true; continue; }
      return all("unclassified-public-runtime");
    }
    if (pipeline(path)) continue;
    return all("unclassified-path");
  }
  return result;
}

export function selectChanges(env = process.env, git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim(), { currentOnly = false } = {}) {
  const sha = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("An exact checked-out SHA is required.");
  if (git(["rev-parse", "HEAD"]) !== sha) throw new Error("Checkout differs from the event SHA.");
  try {
    if (env.GITHUB_EVENT_NAME === "workflow_dispatch") return { ...all("manual-full-check"), source_sha: sha };
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const base = env.GITHUB_EVENT_NAME === "pull_request" ? event.pull_request?.base?.sha : env.GITHUB_EVENT_NAME === "push" ? event.before : null;
    if (!/^[a-f0-9]{40}$/.test(base ?? "") || /^0+$/.test(base)) return { ...all("missing-base", true), source_sha: sha };
    // --no-renames includes both the removed and added paths for renames.
    const paths = git(["diff", "--name-only", "--no-renames", "-z", base, sha]).split("\0").filter(Boolean);
    const packageRuntimeChanged = !paths.includes("package.json") || runtimePackageChanged(git(["show", base + ":package.json"]), git(["show", sha + ":package.json"]));
    const current = classifyChanges(paths, { packageRuntimeChanged });
    if (env.GITHUB_EVENT_NAME !== "push" || currentOnly || current.deploy === false) return { ...current, source_sha: sha };
    const deployed = env.DEPLOYMENT_BASELINE_SHA;
    if (env.DEPLOYMENT_BASELINE_KNOWN !== "true" || !/^[a-f0-9]{40}$/.test(deployed ?? "")) return { ...all("unknown-deployment-baseline", true), source_sha: sha };
    git(["merge-base", "--is-ancestor", deployed, sha]);
    if (deployed === sha) return { ...current, deploy: false, reason: "already-deployed", source_sha: sha };
    const pendingPaths = git(["diff", "--name-only", "--no-renames", "-z", deployed, sha]).split("\0").filter(Boolean);
    const pendingPackage = !pendingPaths.includes("package.json") || runtimePackageChanged(git(["show", deployed + ":package.json"]), git(["show", sha + ":package.json"]));
    const pending = classifyChanges(pendingPaths, { packageRuntimeChanged: pendingPackage });
    // Pending changes choose tests, but a docs-only push never catches up a paid deployment.
    return { ...current, known: current.known && pending.known, ...Object.fromEntries(SUITES.map(key => [key, current[key] || pending[key]])), source_sha: sha };
  } catch { return { ...all("unavailable-diff", true), source_sha: sha }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = selectChanges(process.env, undefined, { currentOnly: process.argv[2] === "--current-only" });
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => key + "=" + value).join("\n") + "\n");
  console.log("CI selection: " + plan.reason + "; deployment required: " + plan.deploy);
}

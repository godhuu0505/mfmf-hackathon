// Local-only validation of current source. Never load existing env files or
// supply cloud credentials. Docker/DB/emulator fixtures remain disposable.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const suite = args[0] === "--suite" ? args[1] : "full";
if (!["full", "fast", "mcp", "containers", "database", "supabase", "e2e"].includes(suite) || args.some((arg, index) => arg !== "--keep" && !(args[0] === "--suite" && index < 2))) throw new Error("Use --suite full|fast|mcp|containers|database|supabase|e2e [--keep].");
if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use Node.js 22.");
mkdirSync(join(root, "work"), { recursive: true });
const directory = mkdtempSync(join(root, "work/local-check-"));
const env = Object.fromEntries(["PATH", "TMPDIR", "TEMP", "SystemRoot", "DOCKER_CONTEXT", "JAVA_HOME", "LANG", "TERM"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { CI: "true", NEXT_TELEMETRY_DISABLED: "1", FIREBASE_SKIP_UPDATE_CHECK: "1", FIREBASE_CLI_DISABLE_USAGE: "true", NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon-key", TOKEN_ENC_KEY: "e2e-local-dummy" });
const run = (command, commandArgs = [], capture = false, extra = {}) => {
  console.log("[local-check] " + command + " " + commandArgs.join(" "));
  const result = spawnSync(command, commandArgs, { cwd: directory, env: { ...env, ...extra }, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Local check failed: " + command + " " + commandArgs.join(" "));
  return result.stdout?.trim() ?? "";
};
const npm = (...commandArgs) => run("npm", commandArgs);
const nodeTests = dir => run(process.execPath, ["--test", ...readdirSync(join(directory, dir)).filter(name => name.endsWith(".test.mjs")).map(name => dir + "/" + name)]);
let ownsSupabase = false, smoke = false, failed = true;
try {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).split("\0").filter(Boolean);
  for (const path of paths) {
    if (path.startsWith("work/") || /(?:^|\/)\.env[^/]*$/.test(path) && !path.endsWith(".example")) continue;
    const source = join(root, path);
    if (!existsSync(source)) continue; // staged/unstaged deletion
    if (lstatSync(source).isSymbolicLink() || path.startsWith("../") || path.startsWith("/")) throw new Error("Unsupported source link/path.");
    mkdirSync(dirname(join(directory, path)), { recursive: true }); cpSync(source, join(directory, path));
  }
  // Reuse installed dependency bytes; generated .next/test output stays isolated.
  if (!existsSync(join(root, "node_modules"))) throw new Error("Install locked dependencies with npm ci first.");
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  if (["full", "fast"].includes(suite)) {
    npm("run", "lint"); npm("run", "typecheck"); npm("run", "test:unit");
    nodeTests("tests/ci"); nodeTests("tests/scripts");
    run("age", ["--version"]); run("bash", ["tests/scripts/backup-db.test.sh"]); run("python3", ["tests/scripts/gcp-bootstrap.test.py"]);
    npm("run", "build");
  }
  if (["full", "mcp"].includes(suite)) { run("java", ["-version"]); npm("run", "test:mcp"); }
  if (["full", "containers", "database", "supabase", "e2e"].includes(suite)) run("docker", ["info"], true);
  if (["full", "containers"].includes(suite)) {
    const fixture = Buffer.alloc(32, 6).toString("base64");
    for (const gcp of [false, true]) {
      const image = gcp ? "mfmf-cloudrun-gcp:ci" : "mfmf-cloudrun:ci";
      run("docker", ["build", "--platform", "linux/amd64", "-f", "Dockerfile.cloudrun", "--build-arg", "NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co", "--build-arg", "NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key", "--build-arg", "NEXT_SERVER_ACTIONS_KEY_VERSION=ci-fixture-v1", ...(gcp ? ["--build-arg", "NEXT_PUBLIC_GCP_AUTH_ENABLED=true"] : []), "--secret", "id=next-server-actions-key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY", "-t", image, "."], false, { NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: fixture });
      if (run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "id", image, "-u"], true) !== "1000") throw new Error("Container must run as non-root.");
    }
    run(process.execPath, ["tests/scripts/cloudrun-image-key.mjs"]);
    run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", "mfmf-cloudrun-gcp:ci", "-e", 'if(process.env.GCP_AUTH_ENABLED !== "true" || process.env.NEXT_PUBLIC_GCP_AUTH_ENABLED !== "true") process.exit(1)']);
    const name = "mfmf-local-smoke-" + process.pid;
    run("docker", ["run", "-d", "--name", name, "-p", "127.0.0.1::8080", "mfmf-cloudrun:ci"]); smoke = name;
    const port = run("docker", ["port", name, "8080/tcp"], true).split(":").pop();
    run(process.execPath, ["tests/scripts/cloudrun-smoke.mjs"], false, { SMOKE_ORIGIN: "http://127.0.0.1:" + port });
  }
  if (["full", "database"].includes(suite)) {
    run("docker", ["build", "--target", "database-tools", "-t", "mfmf-db-tools:20261028", "-f", "Dockerfile.cloudrun", "."]);
    run("python3", ["tests/gcp/run-db-tests.py"]);
    run(process.execPath, ["tests/scripts/source-database-cutover-local.mjs"]);
    run("python3", ["tests/gcp/run-operator-tests.py"]);
    run(process.execPath, ["tests/gcp/postgrest-proof.mjs"]);
    run("docker", ["run", "--rm", "--network", "none", "mfmf-db-operator-test:local"]);
  }
  if (["full", "supabase", "e2e"].includes(suite)) {
    // Do not reuse or stop a developer's existing local database.
    if (run("docker", ["ps", "-aq", "--filter", "name=^supabase_db_mfmf$"], true)) throw new Error("An existing mfmf Supabase stack must be stopped by its owner first.");
    ownsSupabase = true; run("supabase", ["start"]);
    const status = JSON.parse(run("supabase", ["status", "-o", "json"], true));
    if (!status.API_URL?.startsWith("http://127.0.0.1:") || !status.ANON_KEY) throw new Error("Expected the disposable loopback Supabase fixture.");
    env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL; env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.ANON_KEY;
    if (["full", "supabase"].includes(suite)) {
      run(process.execPath, ["tests/scripts/storage-backup-local-sql.mjs"]); run(process.execPath, ["tests/scripts/storage-migration-local-sql.mjs"]);
      run("supabase", ["test", "db"]); npm("run", "test:integration");
    }
    if (["full", "e2e"].includes(suite)) {
      npm("run", "build"); npm("run", "test:e2e"); npm("run", "test:mcp-ui");
    }
  }
  failed = false;
  console.log("Local suite passed: " + suite);
} finally {
  if (smoke) run("docker", ["rm", "-f", smoke]);
  if (ownsSupabase) run("supabase", ["stop", "--no-backup"]);
  if (!failed && !args.includes("--keep")) rmSync(directory, { recursive: true, force: true });
  else console.log("Isolated source and diagnostics: " + directory);
}

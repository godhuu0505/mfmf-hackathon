import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlatformImage, PlatformImageError } from "../../scripts/gcp/resolve-platform-image.mjs";
import { platformImageFixture } from "./fixtures/platform-image.mjs";

const imageBase = "asia-northeast1-docker.pkg.dev/mfmf-499612/mfmf/mfmf-db-operator";
const token = "synthetic-private-token";
const resolve = (f, overrides = {}) => resolvePlatformImage({ reference: f.reference, imageBase, token, fetchImpl: f.fetchImpl, ...overrides });
test("pins the unique linux/amd64 child and config through a verified index with an attestation", async () => {
  const f = platformImageFixture(imageBase);
  assert.equal(await resolve(f), f.platformImage); assert.notEqual(f.reference, f.platformImage); assert.equal(f.calls.length, 3);
  for (const { url, init } of f.calls) {
    assert.ok(url.startsWith(`https://asia-northeast1-docker.pkg.dev/v2/mfmf-499612/mfmf/mfmf-db-operator/`));
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`oauth2accesstoken:${token}`).toString("base64")}`);
    assert.ok(init.signal instanceof AbortSignal);
  }
});
test("verifies an already direct platform manifest instead of changing its digest", async () => {
  const f = platformImageFixture(imageBase, { index: false });
  assert.equal(await resolve(f), f.reference); assert.equal(f.calls.length, 2);
});
test("also verifies the Docker v2 index, image and config media types", async () => {
  const f = platformImageFixture(imageBase, {
    mutateIndex: value => { value.mediaType = "application/vnd.docker.distribution.manifest.list.v2+json"; },
    mutateManifest: value => { value.mediaType = "application/vnd.docker.distribution.manifest.v2+json";
      value.config.mediaType = "application/vnd.docker.container.image.v1+json"; },
  });
  assert.equal(await resolve(f), f.platformImage);
});
for (const kind of ["index", "manifest", "config"]) test(`rejects ${kind} raw-byte digest mismatch`, async () => {
  const f = platformImageFixture(imageBase, { response: (url, _init, bytes) => {
    const selected = kind === "config" ? url.includes("/blobs/") : kind === "index" ? bytes.includes(Buffer.from('"manifests"')) : bytes.includes(Buffer.from('"layers"'));
    return selected ? new Response(Buffer.concat([bytes, Buffer.from(" ")])) : undefined;
  } });
  await assert.rejects(resolve(f), PlatformImageError);
});
for (const [label, options] of [
  ["absent platform", { mutateIndex: value => { value.manifests[0].platform.architecture = "arm64"; } }],
  ["ambiguous platform", { mutateIndex: value => { value.manifests.push(structuredClone(value.manifests[0])); } }],
  ["unsupported platform variant", { mutateIndex: value => { value.manifests[0].platform.variant = "v3"; } }],
  ["attestation masquerading as runnable", { mutateIndex: value => { value.manifests[0].annotations = { "vnd.docker.reference.type": "attestation-manifest" }; } }],
  ["external child URL", { mutateIndex: value => { value.manifests[0].urls = ["https://foreign.test/manifest"]; } }],
  ["nested index", { mutateIndex: value => { value.manifests[0].mediaType = value.mediaType; } }],
  ["child size mismatch", { mutateIndex: value => { value.manifests[0].size++; } }],
  ["config size mismatch", { mutateManifest: value => { value.config.size++; } }],
  ["unrelated config type", { mutateManifest: value => { value.config.mediaType = "application/json"; } }],
  ["external config URL", { mutateManifest: value => { value.config.urls = ["https://foreign.test/config"]; } }],
  ["config OS mismatch", { mutateConfig: value => { value.os = "windows"; } }],
  ["config architecture mismatch", { mutateConfig: value => { value.architecture = "arm64"; } }],
  ["config feature requirement", { mutateConfig: value => { value["os.features"] = ["unsupported"]; } }],
  ["non-executable artifact", { mutateManifest: value => { value.artifactType = "application/vnd.in-toto+json"; } }],
  ["foreign layer URL", { mutateManifest: value => { value.layers[0].urls = ["https://foreign.test/layer"]; } }],
]) test(`rejects ${label} without following foreign descriptors`, async () => {
  const f = platformImageFixture(imageBase, options); await assert.rejects(resolve(f), PlatformImageError);
  assert.ok(f.calls.every(({ url }) => new URL(url).hostname === "asia-northeast1-docker.pkg.dev"));
});
test("rejects foreign repository references before any network access", async () => {
  const f = platformImageFixture(imageBase);
  for (const overrides of [{ reference: f.reference.replace("/mfmf/", "/other/") }, { imageBase: imageBase.replace("asia-northeast1", "europe-west1") },
    { imageBase: `${imageBase}/../other` }, { token: "bad\ntoken" }]) await assert.rejects(resolve(f, overrides), PlatformImageError);
  assert.equal(f.calls.length, 0);
});
for (const [label, response] of [
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://foreign.test/" } })],
  ["oversized Content-Length", () => new Response("{}", { headers: { "content-length": "1048577" } })],
  ["oversized chunked body", () => new Response(Buffer.alloc(1048577, 32))],
  ["different registry digest header", (_url, _init, bytes) => new Response(bytes, { headers: { "docker-content-digest": `sha256:${"0".repeat(64)}` } })],
  ["upstream failure", () => new Response("synthetic-private-response", { status: 403 })],
  ["network failure", () => { throw new Error("synthetic-private-response"); }],
]) test(`fails closed on ${label} with fixed diagnostics`, async () => {
  const f = platformImageFixture(imageBase, { response });
  await assert.rejects(resolve(f), error => error instanceof PlatformImageError && !error.message.includes("synthetic-private"));
  assert.equal(f.calls.length, 1);
});

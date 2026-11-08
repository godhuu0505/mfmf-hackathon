import { createHash } from "node:crypto";
export const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encode = value => Buffer.from(JSON.stringify(value));
export function platformImageFixture(imageBase, { index = true, mutateConfig, mutateManifest, mutateIndex, response } = {}) {
  const config = { architecture: "amd64", os: "linux", config: {}, rootfs: { type: "layers", diff_ids: [sha("synthetic-layer")] } };
  mutateConfig?.(config); const configBytes = encode(config), configDigest = sha(configBytes);
  const manifest = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configBytes.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha("synthetic-layer"), size: 15 }] };
  mutateManifest?.(manifest); const manifestBytes = encode(manifest), manifestDigest = sha(manifestBytes);
  const parent = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
    { mediaType: manifest.mediaType, digest: manifestDigest, size: manifestBytes.length, platform: { architecture: "amd64", os: "linux" } },
    { mediaType: manifest.mediaType, digest: sha("synthetic-attestation"), size: 200, platform: { architecture: "unknown", os: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest" } },
  ] };
  mutateIndex?.(parent); const indexBytes = encode(parent), indexDigest = sha(indexBytes);
  const prefix = `https://${imageBase.slice(0, imageBase.indexOf("/"))}/v2/${imageBase.slice(imageBase.indexOf("/") + 1)}`;
  const values = new Map([[`${prefix}/manifests/${indexDigest}`, indexBytes],
    [`${prefix}/manifests/${manifestDigest}`, manifestBytes], [`${prefix}/blobs/${configDigest}`, configBytes]]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (!values.has(url)) throw new Error("Untrusted fixture endpoint");
    const expected = values.get(url);
    return response?.(url, init, expected) ?? new Response(expected, { headers: { "docker-content-digest": sha(expected) } });
  };
  return { reference: `${imageBase}@${index ? indexDigest : manifestDigest}`, platformImage: `${imageBase}@${manifestDigest}`,
    configDigest, manifestDigest, indexDigest, calls, fetchImpl };
}

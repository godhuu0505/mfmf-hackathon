import { createHash } from "node:crypto";

const REGISTRY = "asia-northeast1-docker.pkg.dev";
const INDEX_TYPES = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const IMAGE_TYPES = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const CONFIG_TYPES = ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"];
const LIMIT = 1024 * 1024;
const digest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
export class PlatformImageError extends Error {
  constructor() { super("Artifact Registry linux/amd64 image verification failed; details withheld."); }
}
const need = value => { if (!value) throw new PlatformImageError(); };
const descriptor = value => object(value) && digest(value.digest) && Number.isSafeInteger(value.size)
  && value.size > 0 && value.urls === undefined && value.data === undefined;
const absentOrEmptyArray = value => value === undefined || (Array.isArray(value) && value.length === 0);
const platform = value => object(value) && value.os === "linux" && value.architecture === "amd64"
  && (value.variant === undefined || value.variant === "") && (value["os.version"] === undefined || value["os.version"] === "")
  && absentOrEmptyArray(value["os.features"]) && absentOrEmptyArray(value.features);

/** Resolve an immutable pushed index to the exact runnable image Cloud Run uses.
 * Verify raw-byte digests and descriptor sizes through index -> manifest -> config.
 * Only the fixed registry/repositories are read; attestation children never run.
 */
export async function resolvePlatformImage({ reference, imageBase, token, fetchImpl = fetch }) {
  try {
    need(typeof imageBase === "string" && new RegExp(`^${REGISTRY.replaceAll(".", "\\.")}/[a-z][a-z0-9-]{4,28}[a-z0-9]/mfmf/mfmf-(candidate|db-operator)$`).test(imageBase));
    need(typeof reference === "string" && reference.startsWith(`${imageBase}@`) && digest(reference.slice(imageBase.length + 1)));
    need(typeof token === "string" && token.length > 0 && token.length <= 16384 && !/[\s\u0000-\u001f\u007f-\uffff]/u.test(token));
    const repository = imageBase.slice(REGISTRY.length + 1);
    const read = async (kind, expectedDigest, expectedSize) => {
      need(digest(expectedDigest) && (expectedSize === undefined || expectedSize <= LIMIT));
      const response = await fetchImpl(`https://${REGISTRY}/v2/${repository}/${kind}/${expectedDigest}`, {
        method: "GET", redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Basic ${Buffer.from(`oauth2accesstoken:${token}`).toString("base64")}`,
          Accept: [...INDEX_TYPES, ...IMAGE_TYPES, ...CONFIG_TYPES, "application/octet-stream"].join(", ") },
      });
      if (response.status !== 200) { await response.body?.cancel(); throw new PlatformImageError(); }
      const returnedDigest = response.headers.get("docker-content-digest");
      need((!returnedDigest || returnedDigest === expectedDigest) && Number(response.headers.get("content-length")) <= LIMIT);
      need(response.body);
      const parts = []; let bytes = 0;
      for await (const part of response.body) { bytes += part.length; need(bytes <= LIMIT); parts.push(Buffer.from(part)); }
      const body = Buffer.concat(parts);
      need((expectedSize === undefined || body.length === expectedSize)
        && `sha256:${createHash("sha256").update(body).digest("hex")}` === expectedDigest);
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); need(object(value)); return value;
    };
    let imageDigest = reference.slice(imageBase.length + 1);
    let manifest = await read("manifests", imageDigest);
    need(manifest.schemaVersion === 2);
    if (INDEX_TYPES.includes(manifest.mediaType)) {
      need(Array.isArray(manifest.manifests) && manifest.manifests.length > 0 && manifest.manifests.length <= 100);
      const candidates = manifest.manifests.filter(item => platform(item?.platform));
      need(candidates.length === 1);
      const child = candidates[0];
      need(descriptor(child) && IMAGE_TYPES.includes(child.mediaType) && !child.artifactType
        && child.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest");
      imageDigest = child.digest; manifest = await read("manifests", imageDigest, child.size);
      need(manifest.mediaType === child.mediaType);
    }
    need(manifest.schemaVersion === 2 && IMAGE_TYPES.includes(manifest.mediaType) && !manifest.artifactType && !manifest.subject);
    need(descriptor(manifest.config) && CONFIG_TYPES.includes(manifest.config.mediaType));
    need(Array.isArray(manifest.layers) && manifest.layers.length > 0 && manifest.layers.length <= 1000
      && manifest.layers.every(item => descriptor(item) && ["application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.v1.tar+zstd", "application/vnd.docker.image.rootfs.diff.tar.gzip"].includes(item.mediaType)));
    const config = await read("blobs", manifest.config.digest, manifest.config.size);
    need(platform(config));
    return `${imageBase}@${imageDigest}`;
  } catch { throw new PlatformImageError(); }
}

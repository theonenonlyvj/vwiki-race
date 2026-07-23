import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv } from "vite";

// Same-origin routing (2026-07-23): the DEFAULT production build now ships
// with NO VITE_VWIKI_RACE_API_URL. The client resolves its API origin at
// runtime - its own *.pages.dev origin (where the /api/* Pages Function
// forwards to the Worker over a service binding) or the legacy Worker origin
// anywhere else. Setting VITE_VWIKI_RACE_API_URL is the explicit pin/rollback
// escape hatch, and such a build must bake that origin in.
const configuredOrigin = loadEnv("production", process.cwd(), "").VITE_VWIKI_RACE_API_URL;
const absoluteUrlMarker = "VWIKI_ABSOLUTE_API_URL_REQUIRED";
const legacyWorkerOrigin = "https://vwikirace-api.theonenonlyvj.workers.dev";
const sameOriginHostSuffix = ".pages.dev";

const bundle = await readBundle(join(process.cwd(), "dist"));
if (configuredOrigin) {
  if (!configuredOrigin.startsWith("https://")) {
    throw new Error("VITE_VWIKI_RACE_API_URL, when set, must be an HTTPS Worker origin.");
  }
  if (!bundle.includes(configuredOrigin.replace(/\/+$/, ""))) {
    throw new Error("The production bundle does not contain the configured Worker origin.");
  }
}
if (!bundle.includes(legacyWorkerOrigin)) {
  throw new Error("The production bundle does not retain the legacy Worker origin fallback.");
}
if (!bundle.includes(sameOriginHostSuffix)) {
  throw new Error("The production bundle does not retain the same-origin *.pages.dev resolution.");
}
if (!bundle.includes(absoluteUrlMarker)) {
  throw new Error("The production bundle does not retain the absolute API URL invariant.");
}
if (/fetch\s*\(\s*["']\/api(?:\/|["'])/.test(bundle)) {
  throw new Error("The production bundle contains a relative /api fetch call.");
}
if (/globalThis\.fetch\.bind\(globalThis\)/.test(bundle)) {
  throw new Error("The production bundle contains an unstable bound global fetch.");
}

async function readBundle(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? readBundle(path)
        : entry.name.endsWith(".js")
          ? readFile(path, "utf8")
          : "";
    }),
  );
  return parts.join("\n");
}

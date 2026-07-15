import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv } from "vite";

const apiOrigin = loadEnv("production", process.cwd(), "").VITE_VWIKI_RACE_API_URL;
const absoluteUrlMarker = "VWIKI_ABSOLUTE_API_URL_REQUIRED";
if (!apiOrigin?.startsWith("https://")) {
  throw new Error("VITE_VWIKI_RACE_API_URL must be an HTTPS Worker origin.");
}

const bundle = await readBundle(join(process.cwd(), "dist"));
if (!bundle.includes(apiOrigin.replace(/\/+$/, ""))) {
  throw new Error("The production bundle does not contain the configured Worker origin.");
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

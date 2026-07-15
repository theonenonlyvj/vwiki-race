export interface ResolveApiOriginOptions {
  production?: boolean;
}

export function resolveApiOrigin(
  value: string | undefined,
  options: ResolveApiOriginOptions = {},
): string {
  const configured = (value ?? "").trim();

  if (!configured && !options.production) {
    return "";
  }
  const origin = readCanonicalHttpsOrigin(configured);
  if (!origin) {
    throw new Error(
      options.production
        ? "VITE_VWIKI_RACE_API_URL must be a configured HTTPS Worker origin for production builds."
        : "VITE_VWIKI_RACE_API_URL must be a canonical HTTPS origin.",
    );
  }

  return origin;
}

function readCanonicalHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const valid = url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (value === url.origin || value === `${url.origin}/`);
    return valid ? url.origin : null;
  } catch {
    return null;
  }
}

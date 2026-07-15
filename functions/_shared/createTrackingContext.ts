import { ApiError } from "../../src/server/http";

const MAX_BODY_BYTES = 16 * 1024;

export interface Env {
  VWIKI_RACE_API_URL: string;
}

export async function proxyCanonicalApi(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  try {
    const target = canonicalTarget(request, env);
    const body = await boundedBody(request);
    const headers = new Headers(request.headers);
    headers.delete("Host");
    headers.delete("Content-Length");
    return await fetchImpl(new Request(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    }));
  } catch (caught) {
    if (caught instanceof ApiError) {
      return Response.json(
        { error: { code: caught.code, message: caught.message } },
        {
          status: caught.status,
          headers: {
            "Cache-Control": "no-store",
            ...(caught.retryAfterSeconds === null
              ? {}
              : { "Retry-After": String(caught.retryAfterSeconds) }),
          },
        },
      );
    }
    return Response.json(
      {
        error: {
          code: "canonical_api_unavailable",
          message: "The canonical VWiki Race API is unavailable.",
        },
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function canonicalTarget(request: Request, env: Env): URL {
  let base: URL;
  try {
    base = new URL(env.VWIKI_RACE_API_URL);
  } catch {
    throw new ApiError(
      "canonical_api_unconfigured",
      "The canonical VWiki Race API is not configured.",
      503,
    );
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new ApiError(
      "canonical_api_unconfigured",
      "The canonical VWiki Race API is not configured.",
      503,
    );
  }
  const incoming = new URL(request.url);
  base.pathname = incoming.pathname;
  base.search = incoming.search;
  base.hash = "";
  return base;
}

async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    return undefined;
  }
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    throw bodyTooLarge();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw bodyTooLarge();
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function bodyTooLarge(): ApiError {
  return new ApiError(
    "body_too_large",
    "Request body must be 16 KiB or smaller.",
    413,
  );
}

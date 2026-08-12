import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { type AdminPageInput, adminHtmlResponse, adminTextResponse } from "./admin.js";
import { MAX_ADMIN_FORM_BYTES, MAX_MCP_REQUEST_BYTES } from "./constants.js";
import type { GrokState } from "./grokState.js";
import { createMcpHandlerForEnv } from "./mcp.js";
import type { LoginData, MessageData, ToolResult } from "./types.js";
import { extractAdminRoute, isAuthorizedAdminPath, isAuthorizedMcpPath } from "./urlAuth.js";
import { resolveModel } from "./xaiClient.js";

export { GrokState } from "./grokState.js";

type RuntimeEnv = Env & {
  // Kept optional so focused Miniflare tests and a partially configured old
  // deployment fail closed instead of crashing before the admin route check.
  ADMIN_URL_TOKEN?: string;
  CF_VERSION_METADATA?: { id?: string };
};

class BodyReadError extends Error {
  constructor(public status: number) {
    super(status === 413 ? "Request body too large" : "Malformed request body");
  }
}

function state(env: Env): DurableObjectStub<GrokState> {
  return env.GROK_STATE.get(env.GROK_STATE.idFromName("single-user"));
}

function headerRejection(request: Request, url: URL): Response | undefined {
  return (
    hostHeaderValidationResponse(request, [url.hostname]) ??
    originValidationResponse(request, [url.hostname]) ??
    undefined
  );
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  // Enforce both declared and streamed sizes before any JSON/form parser sees
  // attacker-controlled input; Content-Length alone is not trustworthy.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new BodyReadError(413);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new BodyReadError(413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readAdminForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") throw new BodyReadError(415);
  const body = await readBoundedBody(request, MAX_ADMIN_FORM_BYTES);
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new BodyReadError(400);
  }
}

function hasOnlyFields(form: URLSearchParams, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  for (const key of form.keys()) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function adminInput(
  requestUrl: URL,
  env: RuntimeEnv,
  adminBasePath: string,
  status: AdminPageInput["status"],
  extra: Pick<AdminPageInput, "login" | "notice"> = {},
): AdminPageInput {
  return {
    adminBasePath,
    mcpUrl: `${requestUrl.origin}/t/${env.MCP_URL_TOKEN}/mcp`,
    model: resolveModel(env.GROK_X_SEARCH_MODEL),
    workerVersion: env.CF_VERSION_METADATA?.id ?? "Not available",
    status,
    ...extra,
  };
}

async function renderAdmin(
  requestUrl: URL,
  env: RuntimeEnv,
  adminBasePath: string,
  extra: {
    login?: ToolResult<LoginData>;
    notice?: ToolResult<MessageData>;
  } = {},
  responseStatus = 200,
): Promise<Response> {
  const grok = state(env);
  const status = await grok.getStatus();
  return adminHtmlResponse(
    adminInput(requestUrl, env, adminBasePath, status, extra),
    responseStatus,
  );
}

async function handleAdmin(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  adminBasePath: string,
  action: "view" | "login" | "callback" | "logout",
): Promise<Response> {
  // URL-token authentication happens in fetch() before this function. Host and
  // Origin validation then protects the bearer URL from cross-site form use.
  const rejection = headerRejection(request, url);
  if (rejection) return adminTextResponse("Forbidden", rejection.status);

  if (action === "view") {
    if (request.method !== "GET") return adminTextResponse("Method not allowed", 405, "GET");
    return renderAdmin(url, env, adminBasePath);
  }
  if (request.method !== "POST") return adminTextResponse("Method not allowed", 405, "POST");

  let form: URLSearchParams;
  try {
    form = await readAdminForm(request);
  } catch (error) {
    const status = error instanceof BodyReadError ? error.status : 400;
    return adminTextResponse(
      status === 413
        ? "Request body too large"
        : status === 415
          ? "Unsupported media type"
          : "Malformed form",
      status,
    );
  }

  const grok = state(env);
  if (action === "login") {
    if (!hasOnlyFields(form, []) || [...form.keys()].length !== 0) {
      return adminTextResponse("Malformed form", 400);
    }
    return renderAdmin(url, env, adminBasePath, { login: await grok.startLogin() });
  }
  if (action === "callback") {
    const callbackUrls = form.getAll("callback_url");
    if (!hasOnlyFields(form, ["callback_url"]) || callbackUrls.length !== 1) {
      return adminTextResponse("Malformed form", 400);
    }
    return renderAdmin(url, env, adminBasePath, {
      notice: await grok.completeLogin(callbackUrls[0] ?? ""),
    });
  }

  if (!hasOnlyFields(form, ["confirm"]) || form.getAll("confirm").length !== 1) {
    return adminTextResponse("Malformed form", 400);
  }
  if (form.get("confirm") !== "yes") {
    return adminTextResponse("Logout confirmation required", 400);
  }
  return renderAdmin(url, env, adminBasePath, { notice: await grok.logout() });
}

async function handleMcp(request: Request, env: Env, url: URL): Promise<Response> {
  const rejection = headerRejection(request, url);
  if (rejection) return rejection;

  const requestInit: RequestInit = {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const body = await readBoundedBody(request, MAX_MCP_REQUEST_BYTES);
      requestInit.body = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer;
    } catch (error) {
      if (error instanceof BodyReadError) {
        return new Response(error.message, { status: error.status });
      }
      return new Response("Malformed request body", { status: 400 });
    }
  }
  // The SDK needs only the canonical transport path. Removing the bearer path
  // before delegation also keeps it out of any SDK-generated diagnostic URL.
  url.pathname = "/mcp";
  return createMcpHandlerForEnv(env).fetch(new Request(url, requestInit));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "grokmcp" });
    }

    // Never log request.url here: both protected path segments are passwords.
    // Authenticate an exact route before reading its request body or DO state.
    const runtimeEnv = env as RuntimeEnv;
    const adminRoute = extractAdminRoute(url.pathname);
    if (
      adminRoute &&
      runtimeEnv.ADMIN_URL_TOKEN &&
      (await isAuthorizedAdminPath(url.pathname, runtimeEnv.ADMIN_URL_TOKEN))
    ) {
      return handleAdmin(
        request,
        runtimeEnv,
        url,
        `/admin/t/${adminRoute.token}`,
        adminRoute.action,
      );
    }

    if (await isAuthorizedMcpPath(url.pathname, env.MCP_URL_TOKEN)) {
      return handleMcp(request, env, url);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

import {
  DEFAULT_MODEL,
  HTTP_TIMEOUT_MS,
  MAX_QUERY_LENGTH,
  MAX_RESPONSE_BYTES,
  MAX_WEB_DOMAIN_FILTER_ENTRIES,
  MAX_X_HANDLE_FILTER_ENTRIES,
  XAI_API_RESPONSES_URL,
} from "./constants.js";
import { dateRangeIsOrdered, filtersAreExclusive, isCalendarDate } from "./searchValidation.js";
import { type SearchData, type SearchRequest, ToolError } from "./types.js";

const modelNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CallResponsesInput {
  accessToken: string;
  model: string;
  request: SearchRequest;
  fetchImpl?: typeof fetch;
}

export function resolveModel(configured?: string): string {
  const model = configured?.trim();
  if (model && modelNamePattern.test(model)) return model;
  return DEFAULT_MODEL;
}

function invalid(message: string): never {
  throw new ToolError("BAD_REQUEST", message);
}

function validatedList(value: unknown, name: string, maximumEntries: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumEntries) {
    invalid(`${name} must contain at most ${maximumEntries} entries.`);
  }
  const entries = value.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (entries.some((entry) => entry.length === 0)) {
    invalid(`${name} must contain only non-empty strings.`);
  }
  return entries;
}

function validatedDate(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isCalendarDate(value)) {
    invalid(`${name} must be a real YYYY-MM-DD date.`);
  }
  return value;
}

function enabled(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    invalid(`${name} must be a boolean.`);
  }
  return value === true;
}

export function buildToolEntry(input: SearchRequest): Record<string, unknown> {
  if (input.tool !== "x_search" && input.tool !== "web_search") {
    invalid("Search tool must be x_search or web_search.");
  }
  if (
    typeof input.query !== "string" ||
    input.query.trim().length === 0 ||
    input.query.length > MAX_QUERY_LENGTH
  ) {
    invalid(`Query must contain between 1 and ${MAX_QUERY_LENGTH} characters.`);
  }

  if (input.tool === "x_search") {
    const allowedXHandles = validatedList(
      input.allowedXHandles,
      "allowedXHandles",
      MAX_X_HANDLE_FILTER_ENTRIES,
    );
    const excludedXHandles = validatedList(
      input.excludedXHandles,
      "excludedXHandles",
      MAX_X_HANDLE_FILTER_ENTRIES,
    );
    const fromDate = validatedDate(input.fromDate, "fromDate");
    const toDate = validatedDate(input.toDate, "toDate");
    if (!filtersAreExclusive(allowedXHandles, excludedXHandles)) {
      invalid("allowedXHandles and excludedXHandles are mutually exclusive.");
    }
    if (!dateRangeIsOrdered(fromDate, toDate)) {
      invalid("toDate must not be earlier than fromDate.");
    }
    const entry: Record<string, unknown> = { type: "x_search" };
    if (allowedXHandles?.length) entry.allowed_x_handles = allowedXHandles;
    if (excludedXHandles?.length) entry.excluded_x_handles = excludedXHandles;
    if (fromDate) entry.from_date = fromDate;
    if (toDate) entry.to_date = toDate;
    if (enabled(input.enableImageUnderstanding, "enableImageUnderstanding")) {
      entry.enable_image_understanding = true;
    }
    if (enabled(input.enableVideoUnderstanding, "enableVideoUnderstanding")) {
      entry.enable_video_understanding = true;
    }
    return entry;
  }

  const allowedDomains = validatedList(
    input.allowedDomains,
    "allowedDomains",
    MAX_WEB_DOMAIN_FILTER_ENTRIES,
  );
  const excludedDomains = validatedList(
    input.excludedDomains,
    "excludedDomains",
    MAX_WEB_DOMAIN_FILTER_ENTRIES,
  );
  if (!filtersAreExclusive(allowedDomains, excludedDomains)) {
    invalid("allowedDomains and excludedDomains are mutually exclusive.");
  }
  const entry: Record<string, unknown> = { type: "web_search" };
  const filters: Record<string, unknown> = {};
  if (allowedDomains?.length) filters.allowed_domains = allowedDomains;
  if (excludedDomains?.length) filters.excluded_domains = excludedDomains;
  if (Object.keys(filters).length > 0) entry.filters = filters;
  if (enabled(input.enableImageSearch, "enableImageSearch")) entry.enable_image_search = true;
  if (enabled(input.enableImageUnderstanding, "enableImageUnderstanding")) {
    entry.enable_image_understanding = true;
  }
  return entry;
}

export async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      throw new ToolError(
        "UPSTREAM_TOO_LARGE",
        `The upstream response exceeded the ${maximumBytes} byte limit.`,
      );
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maximumBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new ToolError(
        "UPSTREAM_TOO_LARGE",
        `The upstream response exceeded the ${maximumBytes} byte limit.`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseResponse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new ToolError("UPSTREAM_ERROR", "xAI returned an invalid response.");
}

function upstreamCode(text: string): string | undefined {
  try {
    const body = asRecord(JSON.parse(text));
    const raw = typeof body.code === "string" ? body.code : "";
    const code = raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 120);
    return code || undefined;
  } catch {
    return undefined;
  }
}

function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get("retry-after")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return 60;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 60;
  return Math.min(parsed, 3600);
}

function httpFailure(response: Response, text: string): ToolError {
  if (response.status === 401) {
    return new ToolError(
      "EXPIRED",
      "xAI rejected the login token. Open the Worker administration page and sign in again.",
    );
  }
  if (response.status === 403) {
    const code = upstreamCode(text);
    const suffix = code ? `, code ${code}` : "";
    return new ToolError("FORBIDDEN_403", `xAI denied the request (HTTP 403${suffix}).`);
  }
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return new ToolError(
      "RATE_LIMITED",
      `xAI rate limited the request. Retry after ${retryAfter} seconds.`,
    );
  }
  return new ToolError("UPSTREAM_ERROR", `xAI request failed (HTTP ${response.status}).`);
}

function extractText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of asArray(body.output)) {
    const output = asRecord(item);
    if (output.type !== "message") continue;
    for (const content of asArray(output.content)) {
      const part = asRecord(content);
      if (part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");
  // Raw REST responses expose generated text only through message/output_text
  // entries. A top-level output_text is an SDK convenience property, not the
  // current wire response shape, so accepting it would hide upstream drift.
  throw new ToolError("UPSTREAM_ERROR", "xAI returned no output text.");
}

function extractCitations(body: Record<string, unknown>): string[] {
  const citations: string[] = [];
  for (const item of asArray(body.output)) {
    const output = asRecord(item);
    if (output.type !== "message") continue;
    for (const content of asArray(output.content)) {
      for (const annotation of asArray(asRecord(content).annotations)) {
        const citation = asRecord(annotation);
        if (citation.type === "url_citation" && typeof citation.url === "string") {
          citations.push(citation.url);
        }
      }
    }
  }
  for (const citation of asArray(body.citations)) {
    if (typeof citation === "string") citations.push(citation);
  }
  return [...new Set(citations)];
}

function requestFailure(error: unknown, timedOut: boolean): ToolError {
  if (error instanceof ToolError) return error;
  if (
    timedOut ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return new ToolError("UPSTREAM_TIMEOUT", "The xAI request timed out.");
  }
  return new ToolError("UPSTREAM_ERROR", "The xAI service could not be reached.");
}

export async function callResponses(input: CallResponsesInput): Promise<SearchData> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(XAI_API_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({
        model: input.model,
        input: [{ role: "user", content: input.request.query }],
        tools: [buildToolEntry(input.request)],
      }),
      signal: controller.signal,
    });
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (!response.ok) throw httpFailure(response, text);
    const body = parseResponse(text);
    return {
      text: extractText(body),
      citations: extractCitations(body),
      model: input.model,
    };
  } catch (error) {
    throw requestFailure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

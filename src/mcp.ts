import { createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  APP_VERSION,
  MAX_QUERY_LENGTH,
  MAX_WEB_DOMAIN_FILTER_ENTRIES,
  MAX_X_HANDLE_FILTER_ENTRIES,
} from "./constants.js";
import type { GrokState } from "./grokState.js";
import { dateRangeIsOrdered, filtersAreExclusive, isCalendarDate } from "./searchValidation.js";
import type { SearchData, SearchRequest, ToolResult } from "./types.js";

const querySchema = z.string().min(1).max(MAX_QUERY_LENGTH);
const xHandleFilterSchema = z
  .array(z.string().trim().min(1))
  .max(MAX_X_HANDLE_FILTER_ENTRIES)
  .optional();
const webDomainFilterSchema = z
  .array(z.string().trim().min(1))
  .max(MAX_WEB_DOMAIN_FILTER_ENTRIES)
  .optional();
const dateSchema = z
  .string()
  .refine(isCalendarDate, "Date must be a real YYYY-MM-DD value.")
  .optional();
const xSearchInputSchema = z
  .object({
    query: querySchema,
    allowed_x_handles: xHandleFilterSchema,
    excluded_x_handles: xHandleFilterSchema,
    from_date: dateSchema,
    to_date: dateSchema,
    enable_image_understanding: z.boolean().optional(),
    enable_video_understanding: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (!filtersAreExclusive(input.allowed_x_handles, input.excluded_x_handles)) {
      context.addIssue({
        code: "custom",
        path: ["excluded_x_handles"],
        message: "Allowed and excluded X handles are mutually exclusive.",
      });
    }
    if (!dateRangeIsOrdered(input.from_date, input.to_date)) {
      context.addIssue({
        code: "custom",
        path: ["to_date"],
        message: "to_date must not be earlier than from_date.",
      });
    }
  });
const webSearchInputSchema = z
  .object({
    query: querySchema,
    allowed_domains: webDomainFilterSchema,
    excluded_domains: webDomainFilterSchema,
    enable_image_search: z.boolean().optional(),
    enable_image_understanding: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (!filtersAreExclusive(input.allowed_domains, input.excluded_domains)) {
      context.addIssue({
        code: "custom",
        path: ["excluded_domains"],
        message: "Allowed and excluded domains are mutually exclusive.",
      });
    }
  });
const searchOutputSchema = z.object({
  ok: z.literal(true),
  text: z.string(),
  citations: z.array(z.string()),
  model: z.string(),
});

function state(env: Env): DurableObjectStub<GrokState> {
  const namespace = env.GROK_STATE;
  return namespace.get(namespace.idFromName("single-user"));
}

function toolResult(result: ToolResult<SearchData>) {
  // MCP 2026-07-28 treats structuredContent as the machine-readable result.
  // The matching JSON text block is still recommended by the current spec for
  // clients that render tool content to a human; it is not an old transport shim.
  const content = [{ type: "text" as const, text: JSON.stringify(result) }];
  if (!result.ok) return { content, isError: true as const };
  return { content, structuredContent: result, isError: false as const };
}

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "grokmcp", version: APP_VERSION });
  const grok = state(env);

  server.registerTool(
    "x_search",
    {
      description: "Search current X posts using the authenticated Grok account.",
      inputSchema: xSearchInputSchema,
      outputSchema: searchOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      const request: SearchRequest = {
        tool: "x_search",
        query: input.query,
        allowedXHandles: input.allowed_x_handles,
        excludedXHandles: input.excluded_x_handles,
        fromDate: input.from_date,
        toDate: input.to_date,
        enableImageUnderstanding: input.enable_image_understanding,
        enableVideoUnderstanding: input.enable_video_understanding,
      };
      return toolResult(await grok.search(request));
    },
  );

  server.registerTool(
    "web_search",
    {
      description: "Search the current web using the authenticated Grok account.",
      inputSchema: webSearchInputSchema,
      outputSchema: searchOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      const request: SearchRequest = {
        tool: "web_search",
        query: input.query,
        allowedDomains: input.allowed_domains,
        excludedDomains: input.excluded_domains,
        enableImageSearch: input.enable_image_search,
        enableImageUnderstanding: input.enable_image_understanding,
      };
      return toolResult(await grok.search(request));
    },
  );

  return server;
}

export function createMcpHandlerForEnv(env: Env): McpHttpHandler {
  return createMcpHandler(() => createMcpServer(env), {
    // This deployment intentionally rejects initialize/session-era clients.
    // Every request must use the MCP 2026-07-28 envelope and standard headers.
    legacy: "reject",
    responseMode: "json",
  });
}

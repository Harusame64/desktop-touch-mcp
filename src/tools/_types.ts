/** Standard MCP tool result content block */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Standard MCP tool result (index signature required by MCP SDK) */
export interface ToolResult {
  content: ContentBlock[];
  [key: string]: unknown;
}

/** A callable tool handler */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler<T = any> = (params: T) => Promise<ToolResult>;

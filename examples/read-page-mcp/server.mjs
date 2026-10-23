import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { manuals } from "./fixtures.mjs";

function createServer() {
  const server = new McpServer({ name: "manual-pages", version: "1.0.0" });
  server.registerTool("read_page", {
    description: "读取合成产品手册的一页原文。页码从 1 开始；不总结、不修改。",
    inputSchema: z.object({
      docId: z.enum(["manual-v1", "manual-v2"]),
      page: z.number().int().positive()
    }).strict(),
    annotations: { readOnlyHint: true }
  }, async ({ docId, page }) => {
    const manual = manuals[docId];
    const text = manual.pages[page - 1];
    // stderr is diagnostic; stdout belongs exclusively to the MCP transport.
    console.error(`read_page ${docId} page=${page}`);
    if (text === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: `PAGE_NOT_FOUND: ${docId} 只有 ${manual.pages.length} 页。` }]
      };
    }
    const data = { docId, version: manual.version, page, pageCount: manual.pages.length, text };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data
    };
  });
  return server;
}

serveStdio(createServer);
console.error("manual-pages ready (synthetic fixtures, stdio)");

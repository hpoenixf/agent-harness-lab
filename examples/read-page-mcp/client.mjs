import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

assert.equal(process.version, "v26.11.1", "Use the repository's pinned Node version.");
const client = new Client({ name: "manual-demo", version: "1.0.0" }, {
  versionNegotiation: { mode: { pin: "2026-07-28" } }
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  env: {},
  stderr: "pipe"
});
let diagnostics = "";
let serverPid;
transport.stderr.on("data", chunk => { diagnostics += chunk.toString(); });

const textOf = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
try {
  await client.connect(transport);
  serverPid = transport.pid;
  console.log(`protocol: ${client.getNegotiatedProtocolVersion()}`);

  const tools = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      assert(!seen.has(cursor), "Discovery returned a repeated cursor; inventory is incomplete.");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  assert.deepEqual(tools.map(tool => tool.name), ["read_page"]);
  console.log(`tools: ${tools.map(tool => tool.name).join(", ")}`);

  for (const docId of ["manual-v1", "manual-v2"]) {
    const result = await client.callTool({ name: "read_page", arguments: { docId, page: 2 } });
    assert(!result.isError);
    assert.equal(result.structuredContent.docId, docId);
    assert.equal(result.structuredContent.page, 2);
    assert.equal(result.structuredContent.pageCount, 2);
    console.log(`read ${docId}: ${result.structuredContent.text}`);
  }

  const missing = await client.callTool({ name: "read_page", arguments: { docId: "manual-v2", page: 99 } });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /PAGE_NOT_FOUND/);
  console.log(`missing page: ${textOf(missing)}`);

  const invalid = await client.callTool({ name: "read_page", arguments: { docId: "manual-v2", page: 0 } });
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /Input validation error/);
  console.log(`invalid input: isError=${invalid.isError}`);

  const outside = await client.callTool({ name: "read_page", arguments: { docId: "../../private", page: 1 } });
  assert.equal(outside.isError, true);
  console.log(`unknown document: isError=${outside.isError}`);

  await assert.rejects(
    () => client.callTool({ name: "delete_page", arguments: {} }),
    error => { assert.equal(error.code, -32602); return true; }
  );
  console.log("unknown tool: protocol error -32602");

  const recovered = await client.callTool({ name: "read_page", arguments: { docId: "manual-v1", page: 1 } });
  assert(!recovered.isError);
  assert.equal(recovered.structuredContent.version, "1.0");
  console.log(`after errors: ${recovered.structuredContent.text}`);
} finally {
  await client.close();
}

assert.equal(typeof serverPid, "number");
assert.throws(() => process.kill(serverPid, 0), { code: "ESRCH" });

// Invalid page/docId never reached the business handler; later valid work did.
const handlerCalls = diagnostics.split("\n").filter(line => line.startsWith("read_page "));
assert.equal(handlerCalls.length, 4);
assert(!handlerCalls.some(line => line.includes("page=0") || line.includes("../../private")));
console.log("closed: client transport and child process; invalid arguments did not enter handler");

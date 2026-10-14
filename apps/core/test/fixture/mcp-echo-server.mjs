// Minimal stdio MCP server for P2 tests (spawned by McpManager via node).
// Low-level SDK Server API — no zod, one `echo` tool. Imports resolve through
// apps/core/node_modules (the file lives under apps/core/test/).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the message back, prefixed.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Text to echo" } },
        required: ["message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "echo") {
    return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
  }
  const message = req.params.arguments?.message;
  return { content: [{ type: "text", text: `ECHO: ${typeof message === "string" ? message : "(none)"}` }] };
});

await server.connect(new StdioServerTransport());
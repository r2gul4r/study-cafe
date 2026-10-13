import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "ok";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result = {};
  if (msg.method === "initialize") result = { userAgent: "fake" };
  if (msg.method === "config/read")
    result = { config: { mcp_servers: { private_tools: { enabled: true } } } };
  if (msg.method === "account/read")
    result = {
      account: { type: "chatgpt", email: "must-not-leak@example.com" },
      requiresOpenaiAuth: true,
    };
  if (msg.method === "thread/start") {
    if (msg.params.config["mcp_servers.private_tools.enabled"] !== false)
      throw new Error("Inherited tools were not disabled");
    result = { thread: { id: "thread-1" } };
  }
  if (msg.method === "turn/start") {
    send({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    send({
      id: msg.id,
      result: { turn: { id: "turn-1", status: "inProgress" } },
    });
    if (mode === "hang") return;
    const text = mode === "invalid" ? "not json" : JSON.stringify({ ok: true });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { id: "message-1", type: "agentMessage", text },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: mode === "failure" ? "failed" : "completed",
          items: [],
        },
      },
    });
    return;
  }
  send({ id: msg.id, result });
});

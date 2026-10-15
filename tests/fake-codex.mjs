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
    if (mode === "images") {
      const input = msg.params.input;
      if (
        input.length !== 3 ||
        input[1].text !== "segment: one" ||
        input[2].type !== "localImage" ||
        input[2].path !== "/fixture/page.png" ||
        input[2].detail !== "original"
      )
        throw new Error("Image input contract mismatch");
    }
    send({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    send({
      id: msg.id,
      result: { turn: { id: "turn-1", status: "inProgress" } },
    });
    if (mode === "hang") return;
    const errorInfo = {
      "rate-limit": { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      "usage-limit": "usageLimitExceeded",
      "unknown-error": { "must-not-leak-secret": { httpStatusCode: 429 } },
      recoverable: { responseStreamDisconnected: { httpStatusCode: null } },
    }[mode];
    const error = errorInfo
      ? {
          message: "must-not-leak@example.com Bearer private-token",
          additionalDetails: "private source text",
          codexErrorInfo: errorInfo,
        }
      : undefined;
    if (error)
      send({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          error,
          willRetry: mode === "recoverable",
        },
      });
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
          status:
            mode === "failure" || (error && mode !== "recoverable")
              ? "failed"
              : "completed",
          ...(mode !== "recoverable" ? { error } : {}),
          items: [],
        },
      },
    });
    return;
  }
  send({ id: msg.id, result });
});

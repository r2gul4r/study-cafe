// JSON-RPC boundary fixture with disk-backed history, independent of app storage.
import { createInterface } from "node:readline";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
const mode = process.argv[2] ?? "normal";
const path = "fake-history.json";
const threads = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const save = () =>
  writeFileSync(
    path,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(threads).filter(([, thread]) => !thread.ephemeral),
      ),
    ),
  );
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  appendFileSync("fake-protocol.jsonl", line + "\n");
  if (id === undefined) return;
  const reply = (result) => send({ id, result });
  if (method === "config/read") return reply({ config: {} });
  if (method === "thread/start") {
    const threadId = randomUUID();
    threads[threadId] = {
      ephemeral: params.ephemeral,
      inputs: [],
      active: false,
    };
    save();
    return reply({ thread: { id: threadId, status: { type: "idle" } } });
  }
  if (method === "thread/resume") {
    if (mode === "resume-error")
      return send({
        id,
        error: { code: -32000, message: "Authentication unavailable" },
      });
    const thread = threads[params.threadId];
    if (!thread)
      return send({
        id,
        error: {
          code: -32600,
          message: `no rollout found for thread id ${params.threadId}`,
        },
      });
    return reply({
      thread: {
        id: params.threadId,
        status: { type: thread.active ? "active" : "idle" },
      },
    });
  }
  if (method === "turn/interrupt") {
    threads[params.threadId].active = false;
    save();
    reply({});
    send({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: params.turnId, status: "interrupted", items: [] },
      },
    });
    return;
  }
  if (method !== "turn/start") return reply({});
  const thread = threads[params.threadId];
  if (!thread || thread.active)
    throw new Error("Overlapping or unknown thread");
  const turnId = randomUUID();
  const input = JSON.parse(params.input[0].text);
  thread.inputs.push(input);
  thread.active = true;
  save();
  reply({ turn: { id: turnId, status: "inProgress" } });
  send({
    method: "turn/started",
    params: { threadId: params.threadId, turn: { id: turnId } },
  });
  const task = input.task ?? input;
  if (task.hang) return;
  const output =
    mode === "workflow"
      ? {
          scope: {
            title: "For",
            concepts: [{ area: "Python", name: "For" }],
            references: [],
          },
          questions: [],
          summary: `Turn ${thread.inputs.length}`,
        }
      : { threadId: params.threadId, history: thread.inputs.length, input };
  setTimeout(() => {
    if (!thread.active) return;
    thread.active = false;
    save();
    send({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: {
          id: turnId,
          status: "completed",
          items: [
            {
              id: randomUUID(),
              type: "agentMessage",
              text: JSON.stringify(output),
            },
          ],
        },
      },
    });
  }, task.delayMs ?? 0);
});

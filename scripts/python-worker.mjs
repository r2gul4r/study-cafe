// Runs only inside a Deno process with explicit denial of host I/O.
import { loadPyodide } from "../node_modules/pyodide/pyodide.mjs";
const chunks = [];
for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
const payload = JSON.parse(
  new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c]))),
);
const py = await loadPyodide({
  indexURL: payload.runtime,
  stdout: () => {},
  stderr: () => {},
});
// Runtime reads are only needed during loading. Even the JS bridge gets no
// filesystem permissions while learner code runs.
await Deno.permissions.revoke({ name: "read" });
await Deno.permissions.revoke({ name: "env" });
console.error("STUDY_CAFE_PYTHON_READY");
let input = new TextEncoder().encode(payload.stdin),
  offset = 0;
py.setStdin({
  read: (buffer) => {
    const n = Math.min(buffer.length, input.length - offset);
    buffer.set(input.subarray(offset, offset + n));
    offset += n;
    return n;
  },
});
py.setStdout({ write: (buffer) => Deno.stdout.writeSync(buffer) });
py.setStderr({ write: (buffer) => Deno.stderr.writeSync(buffer) });
try {
  await py.runPythonAsync(payload.code, { filename: "answer.py" });
} catch (error) {
  console.error(String(error));
  Deno.exit(1);
}
Deno.exit(0);

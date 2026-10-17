import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Fault } from "./core.js";
import type { PythonSpec } from "./python-contract.js";

export type Execution = {
  status:
    "passed" | "wrong_output" | "runtime_error" | "timeout" | "output_limit";
  stdout: string;
  stderr: string;
  durationMs: number;
};
const req = createRequire(import.meta.url);
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, "package.json")) && dirname(root) !== root)
  root = dirname(root);
export function pythonRuntime() {
  const deno = join(
    dirname(req.resolve("deno/package.json")),
    process.platform === "win32" ? "deno.exe" : "deno",
  );
  const pyodide = realpathSync(dirname(req.resolve("pyodide/package.json")));
  return {
    available: existsSync(deno),
    deno,
    pyodide,
    worker: join(root, "scripts", "python-worker.mjs"),
    engine: "CPython 3.14 / Pyodide 314.0.7 / Deno 2.9.6",
  };
}
const normalized = (s: string) => s.replaceAll("\r\n", "\n").trimEnd();
export async function runPython(
  code: string,
  stdin: string,
  expected: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Execution> {
  signal?.throwIfAborted();
  const runtime = pythonRuntime();
  if (!runtime.available)
    throw new Fault(
      503,
      "PYTHON_RUNTIME",
      "Python 실행기를 준비하지 못했습니다. pnpm setup:runtimes를 실행한 뒤 재개하세요.",
    );
  return new Promise((accept, reject) => {
    const started = Date.now();
    const child = spawn(
      runtime.deno,
      [
        "run",
        "--no-config",
        "--no-lock",
        "--no-prompt",
        "--no-check",
        "--cached-only",
        "--no-code-cache",
        `--allow-read=${runtime.pyodide}`,
        "--deny-net",
        "--deny-write",
        "--deny-env",
        "--deny-run",
        "--deny-ffi",
        "--deny-import",
        "--deny-sys",
        runtime.worker,
      ],
      {
        cwd: root,
        windowsHide: true,
        env: { SYSTEMROOT: process.env.SYSTEMROOT ?? "", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      bytes = 0,
      ready = false;
    let forced: Execution["status"] | undefined;
    let timer = setTimeout(() => {
      forced = "timeout";
      child.kill();
    }, 20000);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    for (const [stream, isError] of [
      [child.stdout, false],
      [child.stderr, true],
    ] as const) {
      stream.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 32768) {
          forced = "output_limit";
          child.kill();
          return;
        }
        if (isError) {
          stderr += data.toString("utf8");
          if (!ready && stderr.includes("STUDY_CAFE_PYTHON_READY\n")) {
            ready = true;
            stderr = stderr.replace("STUDY_CAFE_PYTHON_READY\n", "");
            clearTimeout(timer);
            timer = setTimeout(() => {
              forced = "timeout";
              child.kill();
            }, timeoutMs);
          }
        } else stdout += data.toString("utf8");
      });
    }
    child.on("error", (error) => {
      cleanup();
      reject(
        new Fault(
          503,
          "PYTHON_RUNTIME",
          `Python 실행기 시작 실패: ${error.message}`,
        ),
      );
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "EOF") {
        child.kill();
        cleanup();
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (!ready) {
        reject(
          new Fault(
            503,
            "PYTHON_RUNTIME",
            "Python 실행기 초기화 실패. 설치를 확인한 뒤 재개하세요.",
            stderr.slice(0, 1500),
          ),
        );
        return;
      }
      accept({
        status:
          forced ??
          (exitCode !== 0
            ? "runtime_error"
            : normalized(stdout) === normalized(expected)
              ? "passed"
              : "wrong_output"),
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
    child.stdin.end(
      JSON.stringify({
        code,
        stdin,
        runtime: runtime.pyodide.replaceAll("\\", "/") + "/",
      }),
    );
  });
}
export async function gradePython(
  code: string,
  spec: PythonSpec,
  signal?: AbortSignal,
) {
  const results = [];
  for (const test of spec.tests) {
    const result = await runPython(
      code,
      test.stdin,
      test.stdout,
      spec.timeoutMs,
      signal,
    );
    results.push({ name: test.name, hidden: test.hidden, ...result });
  }
  return results;
}

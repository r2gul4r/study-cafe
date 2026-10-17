import { z } from "zod";
export const pythonSpec = z
  .object({
    language: z.literal("python"),
    starterCode: z.string().max(20000).default(""),
    timeoutMs: z.number().int().min(1000).max(10000).default(5000),
    tests: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            stdin: z.string().max(10000),
            stdout: z.string().max(10000),
            hidden: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine(
    (s) => s.tests.some((t) => !t.hidden),
    "공개 예제 테스트가 하나 이상 필요합니다.",
  );
export type PythonSpec = z.infer<typeof pythonSpec>;

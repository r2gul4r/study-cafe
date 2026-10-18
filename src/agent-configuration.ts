import { z } from "zod";

// Study-cafe excludes the Daybreak model family from study sessions.
export const isStudyModelAllowed = (model: string) =>
  !model.toLowerCase().includes("daybreak");

// Values come from the installed Codex catalog, never a hard-coded model list.
export const agentConfiguration = z
  .object({
    model: z.string().trim().min(1).max(200),
    effort: z.string().trim().min(1).max(40),
  })
  .strict();
export type AgentConfiguration = z.infer<typeof agentConfiguration>;
export const modelCatalog = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      hidden: z.boolean().optional(),
      defaultReasoningEffort: z.string(),
      supportedReasoningEfforts: z.array(
        z.object({
          reasoningEffort: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

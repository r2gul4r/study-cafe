import type { AgentPort } from "./agent.js";
import { Store } from "./store.js";
import { now, requireThat } from "./core.js";
import {
  agentConfiguration,
  modelCatalog,
  isStudyModelAllowed,
} from "./agent-configuration.js";

export class AgentSettings {
  constructor(
    private store: Store,
    private agent: AgentPort,
  ) {}

  read(goalId: string) {
    this.store.get("goals", goalId);
    const row = this.store.one(
      "SELECT model,effort FROM goal_agent_settings WHERE goal_id=?",
      goalId,
    );
    return {
      configuration: row ? agentConfiguration.parse(row) : null,
      sessionStarted: !!this.store.one(
        "SELECT goal_id FROM goal_sessions WHERE goal_id=?",
        goalId,
      ),
    };
  }

  async models() {
    const catalog = modelCatalog.parse(await this.agent.models());
    return {
      ...catalog,
      data: catalog.data.filter((model) => isStudyModelAllowed(model.model)),
    };
  }

  async save(goalId: string, input: unknown) {
    const configuration = agentConfiguration.parse(input);
    this.assertActive(goalId);
    const catalog = await this.models();
    const model = catalog.data.find(
      (m) => m.model === configuration.model && !m.hidden,
    );
    requireThat(
      model,
      "AGENT_MODEL",
      "현재 Codex 모델 목록에서 선택해 주세요.",
    );
    requireThat(
      model.supportedReasoningEfforts.some(
        (e) => e.reasoningEffort === configuration.effort,
      ),
      "AGENT_EFFORT",
      "선택한 모델이 지원하는 추론 강도를 선택해 주세요.",
    );
    // The goal may have been archived/deleted while the catalog was loading.
    this.assertActive(goalId);
    this.store.run(
      `INSERT INTO goal_agent_settings(goal_id,model,effort,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(goal_id) DO UPDATE SET model=excluded.model,effort=excluded.effort,updated_at=excluded.updated_at`,
      goalId,
      configuration.model,
      configuration.effort,
      now(),
    );
    return this.read(goalId);
  }

  private assertActive(goalId: string) {
    requireThat(
      !this.store.get("goals", goalId).archived,
      "ARCHIVED",
      "보관된 목표입니다.",
    );
  }
}

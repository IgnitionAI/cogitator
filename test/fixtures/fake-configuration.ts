import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS } from "../../src/schemas.js";

/** Configuration half of the existing injected RPC fakes (no real pi process). */
export class FakeConfiguration {
  private selected?: { model: { provider: string; id: string }; thinkingLevel: ThinkingLevel };
  constructor(private args: () => string[]) {}
  private state() {
    if (!this.selected) {
      const args = this.args();
      const raw = args[args.indexOf("--model") + 1] ?? "test/model";
      const [name, thinking = "off"] = raw.split(":");
      const slash = name!.indexOf("/");
      this.selected = { model: { provider: name!.slice(0, slash), id: name!.slice(slash + 1) }, thinkingLevel: thinking as ThinkingLevel };
    }
    return this.selected;
  }
  async getState() { return this.state(); }
  async getAvailableModels() { return [this.state().model, { provider: "deepseek", id: "deepseek-v4-pro" }, { provider: "deepseek", id: "deepseek-flash" }, { provider: "openai", id: "gpt-5.4" }]; }
  async getAvailableThinkingLevels() { return [...THINKING_LEVELS]; }
  async setThinkingLevel(level: ThinkingLevel) { this.state().thinkingLevel = level; }
  async setModel(provider: string, id: string) { this.state().model = { provider, id }; }
}

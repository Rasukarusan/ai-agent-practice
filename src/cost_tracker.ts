import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

// モデルごとの料金 (USD per 1M tokens)
// @see https://ai.google.dev/gemini-api/docs/pricing
// @see https://openai.com/api/pricing/
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Gemini 2.5 シリーズ
  "gemini-2.5-pro-preview-03-25": { input: 1.25, output: 10.0 },
  // Gemini 2.0 シリーズ
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  // Gemini 1.5 シリーズ
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
  // GPT-4 シリーズ
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  // o シリーズ
  o1: { input: 15.0, output: 60.0 },
  "o3-mini": { input: 1.1, output: 4.4 },
};

export class CostTracker extends BaseCallbackHandler {
  name = "CostTracker";

  private usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    apiCalls: 0,
  };

  handleLLMEnd(output: LLMResult) {
    const tokenUsage = output?.llmOutput?.tokenUsage;
    if (tokenUsage) {
      this.usage.promptTokens += tokenUsage.promptTokens ?? 0;
      this.usage.completionTokens += tokenUsage.completionTokens ?? 0;
      this.usage.totalTokens += tokenUsage.totalTokens ?? 0;
    }
    this.usage.apiCalls += 1;
  }

  printReport(model: string) {
    const pricing = MODEL_PRICING[model];

    console.log("\n--- API コストレポート ---");
    console.log(`モデル: ${model}`);
    console.log(`API呼び出し回数: ${this.usage.apiCalls}`);
    console.log(
      `トークン使用量: 入力 ${this.usage.promptTokens} / 出力 ${this.usage.completionTokens} / 合計 ${this.usage.totalTokens}`,
    );

    if (pricing) {
      const inputCost = (this.usage.promptTokens / 1_000_000) * pricing.input;
      const outputCost =
        (this.usage.completionTokens / 1_000_000) * pricing.output;
      const totalCost = inputCost + outputCost;
      console.log(
        `コスト: 入力 $${inputCost.toFixed(6)} + 出力 $${outputCost.toFixed(6)} = 合計 $${totalCost.toFixed(6)}`,
      );
    } else {
      console.log(
        `コスト: モデル "${model}" の料金情報が未登録のため計算できません`,
      );
    }
    console.log("--------------------------------");
  }
}

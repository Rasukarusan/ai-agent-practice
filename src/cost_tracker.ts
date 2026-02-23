import type OpenAI from "openai";

// モデルごとの料金 (USD per 1M tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // GPT-5 シリーズ
  "gpt-5.2": { input: 1.75, output: 14.0 },
  "gpt-5.1": { input: 1.25, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  // GPT-4 シリーズ
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-2024-08-06": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  // o シリーズ
  o1: { input: 15.0, output: 60.0 },
  "o3-mini": { input: 1.1, output: 4.4 },
};

interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  apiCalls: number;
}

export class CostTracker {
  private usage: UsageStats = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    apiCalls: 0,
  };

  /**
   * OpenAI クライアントの chat.completions.parse をラップし、
   * 呼び出しごとに自動でトークン使用量を記録する。
   *
   * NOTE: create はラップしない。parse が内部で create を呼び、
   * SDK の APIPromise チェーン(_thenUnwrap)に依存するため、
   * create をラップすると内部チェーンが壊れる。
   */
  wrap(client: OpenAI): OpenAI {
    const completions = client.chat.completions;
    const usage = this.usage;

    const originalParse = completions.parse.bind(completions);
    completions.parse = (async (...args: Parameters<typeof originalParse>) => {
      const response = await originalParse(...args);
      if (response.usage) {
        usage.promptTokens += response.usage.prompt_tokens;
        usage.completionTokens += response.usage.completion_tokens;
        usage.totalTokens += response.usage.total_tokens;
      }
      usage.apiCalls += 1;
      return response;
    }) as typeof originalParse;

    return client;
  }

  printReport(model: string) {
    const pricing = MODEL_PRICING[model];

    console.log("\n--- OpenAI API コストレポート ---");
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

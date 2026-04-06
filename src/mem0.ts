interface Mem0ClientOptions {
  baseUrl: string;
  userId: string;
  apiKey?: string;
  searchLimit: number;
}

type SearchItem = {
  memory?: string;
  text?: string;
  score?: number;
};

export class Mem0Client {
  private readonly options: Mem0ClientOptions;

  constructor(options: Mem0ClientOptions) {
    this.options = options;
  }

  private createHeaders() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.options.apiKey) {
      headers["X-API-Key"] = this.options.apiKey;
    }

    return headers;
  }

  async addMemory(question: string, answer: string): Promise<void> {
    const response = await fetch(`${this.options.baseUrl}/memories`, {
      method: "POST",
      headers: this.createHeaders(),
      body: JSON.stringify({
        messages: [
          { role: "user", content: question },
          { role: "assistant", content: answer },
        ],
        user_id: this.options.userId,
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Mem0 add failed (${response.status}): ${JSON.stringify(body)}`);
    }
    console.info("Mem0: addMemory response:", JSON.stringify(body, null, 2));
  }

  async searchMemories(query: string): Promise<string[]> {
    const response = await fetch(`${this.options.baseUrl}/search`, {
      method: "POST",
      headers: this.createHeaders(),
      body: JSON.stringify({
        query,
        user_id: this.options.userId,
        limit: this.options.searchLimit,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mem0 search failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      memories?: SearchItem[];
      results?: SearchItem[];
    };
    const items = data.memories ?? data.results ?? [];

    return items
      .map((item) => item.memory ?? item.text)
      .filter((item): item is string => Boolean(item));
  }
}

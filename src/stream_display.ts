const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    w += isFullWidth(ch.codePointAt(0)!) ? 2 : 1;
  }
  return w;
}

function truncateByWidth(
  str: string,
  maxWidth: number,
  suffix = "...",
): string {
  const suffixW = displayWidth(suffix);
  let w = 0;
  let result = "";
  for (const ch of str) {
    const cw = isFullWidth(ch.codePointAt(0)!) ? 2 : 1;
    if (w + cw > maxWidth - suffixW) return result + suffix;
    w += cw;
    result += ch;
  }
  return result;
}

interface StreamLine {
  index: number;
  content: string;
  node: string;
  subtaskNum?: number;
  frame: number;
  startedAt: number;
}

export interface StreamDisplayConfig {
  nodeLabels: Record<string, string>;
  mainGraphNodes: Set<string>;
}

const DEFAULT_CONFIG: StreamDisplayConfig = {
  nodeLabels: {
    create_plan: "計画作成",
    select_tools: "ツール選択",
    execute_tools: "ツール実行",
    create_subtask_answer: "回答生成",
    reflect_subtask: "振り返り",
    create_answer: "最終回答生成",
  },
  mainGraphNodes: new Set(["create_plan", "create_answer"]),
};

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s % 60).toFixed(0)}s`;
}

export class StreamDisplay {
  private lines = new Map<string, StreamLine>();
  private totalLines = 0;
  private subtaskCount = 0;
  private startedAt = Date.now();
  private config: StreamDisplayConfig;

  constructor(config?: Partial<StreamDisplayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  update(node: string, namespace: string, content: string): void {
    const isMainNode = this.config.mainGraphNodes.has(node);
    // サブタスクの各ステップ（ツール選択、実行、回答、振り返り）を
    // 同じサブタスクとしてグルーピングするため、namespaceの最初のセグメントを使用
    const subtaskGroupKey = namespace.split("/")[0];
    const lineKey = isMainNode ? node : subtaskGroupKey;

    // 新しい行の作成
    if (!this.lines.has(lineKey)) {
      if (!isMainNode) this.subtaskCount++;
      this.lines.set(lineKey, {
        index: this.totalLines,
        content: "",
        node,
        frame: 0,
        startedAt: Date.now(),
        ...(!isMainNode && { subtaskNum: this.subtaskCount }),
      });
      if (this.totalLines > 0) process.stderr.write("\n");
      this.totalLines++;
    }

    const line = this.lines.get(lineKey)!;

    // 同じ行内でノードが変わったら内容をリセット
    if (node !== line.node) {
      line.node = node;
      line.content = "";
    }

    line.content += content;

    // ラベル構築
    const nodeLabel = this.config.nodeLabels[node] ?? node;
    const label =
      line.subtaskNum != null
        ? `[サブタスク ${line.subtaskNum}] [${nodeLabel}] `
        : `[${nodeLabel}] `;

    // 表示内容の整形（CJK文字の2カラム幅を考慮）
    const cols = process.stderr.columns || 80;
    const labelW = displayWidth(label);
    const maxWidth = cols - labelW;
    const display = line.content.replace(/\n/g, " ");
    let truncated: string;
    if (displayWidth(display) > maxWidth) {
      const spinner = SPINNER[line.frame++ % SPINNER.length];
      truncated = truncateByWidth(display, maxWidth, ` ${spinner}`);
    } else {
      truncated = display;
    }

    // ANSIカーソル制御で対象行を上書き
    const moveUp = this.totalLines - 1 - line.index;
    if (moveUp > 0) process.stderr.write(`\x1b[${moveUp}A`);
    process.stderr.write(`\r\x1b[K${label}${truncated}`);
    if (moveUp > 0) process.stderr.write(`\x1b[${moveUp}B`);
  }

  showPreviousResults(taskNames: string[]): void {
    for (const name of taskNames) {
      process.stderr.write(`\x1b[32m✔ [完了済み] ${name}\x1b[0m\n`);
      this.totalLines++;
    }
  }

  finish(reason?: "aborted"): void {
    process.stderr.write("\n");
    if (reason === "aborted") {
      process.stderr.write("\x1b[33m⏸  処理を中断しました\x1b[0m\n");
    }

    // 各行の所要時間を表示
    const now = Date.now();
    const sorted = [...this.lines.values()].sort(
      (a, b) => a.index - b.index,
    );
    for (const line of sorted) {
      const duration = formatDuration(now - line.startedAt);
      const nodeLabel = this.config.nodeLabels[line.node] ?? line.node;
      const label =
        line.subtaskNum != null
          ? `[サブタスク ${line.subtaskNum}] [${nodeLabel}]`
          : `[${nodeLabel}]`;
      process.stderr.write(`  ${label} ${duration}\n`);
    }
    const total = formatDuration(now - this.startedAt);
    process.stderr.write(`\x1b[1m合計: ${total}\x1b[0m\n`);
  }
}

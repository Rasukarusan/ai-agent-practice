/**
 * リアルタイム進捗レポーター
 *
 * エージェント実行中の各ステップ（プラン作成、ツール選択・実行、
 * リフレクション等）を stderr にリアルタイムで出力する。
 * stdout は最終結果の JSON 出力用に保持する。
 */
export class ProgressReporter {
  private startTime = Date.now();

  private elapsed(): string {
    return ((Date.now() - this.startTime) / 1000).toFixed(1);
  }

  private log(message: string) {
    process.stderr.write(`[${this.elapsed()}s] ${message}\n`);
  }

  start(question: string) {
    this.startTime = Date.now();
    this.log("エージェント開始");
    this.log(`  質問: ${question}`);
  }

  planCreated(subtasks: string[]) {
    this.log(`プラン作成完了 (${subtasks.length}個のサブタスク)`);
    for (let i = 0; i < subtasks.length; i++) {
      this.log(`  ${i + 1}. ${subtasks[i]}`);
    }
  }

  subtaskStart(index: number, total: number, subtask: string) {
    this.log(`[${index + 1}/${total}] 開始: ${subtask}`);
  }

  toolsSelected(index: number, total: number, toolNames: string[]) {
    this.log(`[${index + 1}/${total}] ツール選択: ${toolNames.join(", ")}`);
  }

  toolExecuted(
    index: number,
    total: number,
    toolName: string,
    args: string,
    resultCount: number,
  ) {
    let argsDisplay = args;
    try {
      const parsed = JSON.parse(args);
      argsDisplay = Object.values(parsed).join(", ");
    } catch {
      /* JSON パース失敗時はそのまま表示 */
    }
    this.log(
      `[${index + 1}/${total}] ${toolName}("${argsDisplay}") -> ${resultCount}件`,
    );
  }

  subtaskAnswerCreated(index: number, total: number) {
    this.log(`[${index + 1}/${total}] 回答作成完了`);
  }

  reflection(
    index: number,
    total: number,
    isCompleted: boolean,
    attempt: number,
    maxAttempts: number,
  ) {
    if (isCompleted) {
      this.log(`[${index + 1}/${total}] リフレクション: OK`);
    } else if (attempt >= maxAttempts) {
      this.log(`[${index + 1}/${total}] リフレクション: NG (上限到達)`);
    } else {
      this.log(
        `[${index + 1}/${total}] リフレクション: NG -> リトライ (${attempt}/${maxAttempts})`,
      );
    }
  }

  creatingFinalAnswer() {
    this.log("最終回答を生成中...");
  }

  done() {
    this.log(`完了 (合計 ${this.elapsed()}s)`);
  }
}

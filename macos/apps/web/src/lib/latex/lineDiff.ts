export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface LineDiffSummary {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  truncated?: boolean;
}

const MAX_DP_LINES = 1400;

/**
 * 计算两个文本之间的逐行差异，用于快照对比和 AI 修改审查。
 * 先裁剪相同的首尾上下文行，再对中间变更窗口做 LCS 动态规划。
 */
export function computeLineDiff(beforeText: string, afterText: string): LineDiffSummary {
  const before = beforeText.replace(/\r\n/g, '\n').split('\n');
  const after = afterText.replace(/\r\n/g, '\n').split('\n');

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    lines.push({ kind: 'context', oldLine: i + 1, newLine: i + 1, text: before[i] ?? '' });
  }

  const midA = before.slice(prefix, before.length - suffix);
  const midB = after.slice(prefix, after.length - suffix);
  let addedCount = 0;
  let removedCount = 0;
  let truncated = false;

  if (midA.length * midB.length > MAX_DP_LINES * MAX_DP_LINES) {
    truncated = true;
    for (let i = 0; i < midA.length; i++) {
      lines.push({ kind: 'del', oldLine: prefix + i + 1, text: midA[i] ?? '' });
      removedCount++;
    }
    for (let j = 0; j < midB.length; j++) {
      lines.push({ kind: 'add', newLine: prefix + j + 1, text: midB[j] ?? '' });
      addedCount++;
    }
  } else {
    const m = midA.length;
    const n = midB.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      const row = dp[i]!;
      const nextRow = dp[i + 1]!;
      const lineA = midA[i] ?? '';
      for (let j = n - 1; j >= 0; j--) {
        if (lineA === (midB[j] ?? '')) {
          row[j] = (nextRow[j + 1] ?? 0) + 1;
        } else {
          const down = nextRow[j] ?? 0;
          const right = row[j + 1] ?? 0;
          row[j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      const lineA = midA[i] ?? '';
      const lineB = midB[j] ?? '';
      if (lineA === lineB) {
        lines.push({
          kind: 'context',
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
          text: lineA,
        });
        i++;
        j++;
      } else {
        const down = dp[i + 1]?.[j] ?? 0;
        const right = dp[i]?.[j + 1] ?? 0;
        if (down >= right) {
          lines.push({ kind: 'del', oldLine: prefix + i + 1, text: lineA });
          removedCount++;
          i++;
        } else {
          lines.push({ kind: 'add', newLine: prefix + j + 1, text: lineB });
          addedCount++;
          j++;
        }
      }
    }
    while (i < m) {
      lines.push({ kind: 'del', oldLine: prefix + i + 1, text: midA[i] ?? '' });
      removedCount++;
      i++;
    }
    while (j < n) {
      lines.push({ kind: 'add', newLine: prefix + j + 1, text: midB[j] ?? '' });
      addedCount++;
      j++;
    }
  }

  for (let s = 0; s < suffix; s++) {
    const oldIdx = before.length - suffix + s;
    const newIdx = after.length - suffix + s;
    lines.push({ kind: 'context', oldLine: oldIdx + 1, newLine: newIdx + 1, text: before[oldIdx] ?? '' });
  }

  return { lines, addedCount, removedCount, truncated };
}

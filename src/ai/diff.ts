export interface DiffLine {
  type: "context" | "add" | "remove" | "ellipsis";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  truncated: boolean;
}

const MAX_LCS_SPAN = 550;
const MAX_DISPLAY_LINES = 400;

/**
 * Computes a clean line-by-line diff between `beforeText` (current state) and
 * `afterText` (target restored state) with collapsed unchanged context blocks.
 */
export function computeLineDiff(
  beforeText: string,
  afterText: string,
  contextLines: number = 3
): DiffResult {
  const normBefore = (beforeText ?? "").replace(/\r\n/g, "\n");
  const normAfter = (afterText ?? "").replace(/\r\n/g, "\n");

  const aLines = normBefore === "" ? [] : normBefore.split("\n");
  const bLines = normAfter === "" ? [] : normAfter.split("\n");

  // 1. Trim identical prefix and suffix lines in O(N)
  let prefix = 0;
  while (
    prefix < aLines.length &&
    prefix < bLines.length &&
    aLines[prefix] === bLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < aLines.length - prefix &&
    suffix < bLines.length - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = aLines.slice(prefix, aLines.length - suffix);
  const midB = bLines.slice(prefix, bLines.length - suffix);

  const rawDiff: DiffLine[] = [];

  // Leading prefix (only keep trailing `contextLines` of prefix)
  if (prefix > contextLines) {
    const skipped = prefix - contextLines;
    rawDiff.push({
      type: "ellipsis",
      text: `... ${skipped} unchanged line${skipped === 1 ? "" : "s"} ...`,
    });
  }
  const prefixStart = Math.max(0, prefix - contextLines);
  for (let i = prefixStart; i < prefix; i++) {
    rawDiff.push({
      type: "context",
      text: aLines[i],
      oldLine: i + 1,
      newLine: i + 1,
    });
  }

  // 2. Compute diff operations on middle slice
  let addedCount = 0;
  let removedCount = 0;
  let truncated = false;

  if (midA.length === 0 && midB.length === 0) {
    // Identical files
  } else if (midA.length <= MAX_LCS_SPAN && midB.length <= MAX_LCS_SPAN) {
    const m = midA.length;
    const n = midB.length;
    const dp: Int32Array[] = Array.from(
      { length: m + 1 },
      () => new Int32Array(n + 1)
    );

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }

    const midOps: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        midOps.push({
          type: "context",
          text: midA[i],
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
        });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        midOps.push({
          type: "remove",
          text: midA[i],
          oldLine: prefix + i + 1,
        });
        removedCount++;
        i++;
      } else {
        midOps.push({
          type: "add",
          text: midB[j],
          newLine: prefix + j + 1,
        });
        addedCount++;
        j++;
      }
    }
    while (i < m) {
      midOps.push({
        type: "remove",
        text: midA[i],
        oldLine: prefix + i + 1,
      });
      removedCount++;
      i++;
    }
    while (j < n) {
      midOps.push({
        type: "add",
        text: midB[j],
        newLine: prefix + j + 1,
      });
      addedCount++;
      j++;
    }

    // Collapse long unchanged context runs inside the middle region
    let idx = 0;
    while (idx < midOps.length) {
      if (midOps[idx].type !== "context") {
        rawDiff.push(midOps[idx]);
        idx++;
      } else {
        let runEnd = idx;
        while (runEnd < midOps.length && midOps[runEnd].type === "context") {
          runEnd++;
        }
        const runLen = runEnd - idx;
        if (runLen <= contextLines * 2 + 1) {
          for (let k = idx; k < runEnd; k++) {
            rawDiff.push(midOps[k]);
          }
        } else {
          for (let k = idx; k < idx + contextLines; k++) {
            rawDiff.push(midOps[k]);
          }
          const hidden = runLen - contextLines * 2;
          rawDiff.push({
            type: "ellipsis",
            text: `... ${hidden} unchanged line${hidden === 1 ? "" : "s"} ...`,
          });
          for (let k = runEnd - contextLines; k < runEnd; k++) {
            rawDiff.push(midOps[k]);
          }
        }
        idx = runEnd;
      }
    }
  } else {
    // Fallback block diff for huge edits exceeding MAX_LCS_SPAN
    for (let i = 0; i < midA.length; i++) {
      rawDiff.push({
        type: "remove",
        text: midA[i],
        oldLine: prefix + i + 1,
      });
      removedCount++;
    }
    for (let j = 0; j < midB.length; j++) {
      rawDiff.push({
        type: "add",
        text: midB[j],
        newLine: prefix + j + 1,
      });
      addedCount++;
    }
  }

  // Trailing suffix (keep leading `contextLines` of suffix)
  const suffixStartA = aLines.length - suffix;
  const suffixStartB = bLines.length - suffix;
  const shownSuffix = Math.min(suffix, contextLines);
  for (let k = 0; k < shownSuffix; k++) {
    rawDiff.push({
      type: "context",
      text: aLines[suffixStartA + k],
      oldLine: suffixStartA + k + 1,
      newLine: suffixStartB + k + 1,
    });
  }
  if (suffix > contextLines) {
    const skipped = suffix - contextLines;
    rawDiff.push({
      type: "ellipsis",
      text: `... ${skipped} unchanged line${skipped === 1 ? "" : "s"} ...`,
    });
  }

  if (rawDiff.length > MAX_DISPLAY_LINES) {
    truncated = true;
    return {
      lines: rawDiff.slice(0, MAX_DISPLAY_LINES),
      addedCount,
      removedCount,
      truncated,
    };
  }

  return {
    lines: rawDiff,
    addedCount,
    removedCount,
    truncated,
  };
}

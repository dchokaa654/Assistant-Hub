import { requestUrl } from "obsidian";
import {
  AISidepanelSettings,
  ChatMessage,
  ReasoningEffort,
  ToolActivityRecord,
  ToolCall,
  getActiveModelReasoningCapability,
  inferProtocolFromBaseUrl,
  normalizeModelBaseId,
} from "../types";
import { VAULT_TOOL_DEFINITIONS, VaultToolExecutor } from "./tools";

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onReasoningChunk?: (text: string) => void;
  onStatus?: (status: string) => void;
  onReset?: () => void;
  onToolActivity?: (activity: ToolActivityRecord) => void;
  signal?: AbortSignal;
}

const MAX_ACTIVITY_PREVIEW_CHARS = 600;
const MAX_REASONING_STORAGE_CHARS = 16000;

function truncatePreview(text: string, maxChars: number = MAX_ACTIVITY_PREVIEW_CHARS): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n… (truncated)`;
}

function describeToolCall(
  name: string,
  rawArgs: string
): { label: string; argsPreview?: string } {
  let parsed: Record<string, unknown> | null = null;
  try {
    if (rawArgs && rawArgs.trim()) {
      const obj: unknown = JSON.parse(rawArgs);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = obj as Record<string, unknown>;
      }
    }
  } catch {
    parsed = null;
  }

  const getStr = (key: string): string => {
    const val = parsed?.[key];
    return typeof val === "string" ? val : "";
  };

  const target =
    getStr("path") ||
    getStr("notePath") ||
    getStr("filePath") ||
    getStr("folderPath") ||
    getStr("sourcePath") ||
    getStr("targetPath") ||
    getStr("query") ||
    getStr("folder") ||
    "";
  const shortTarget =
    target.length > 48 ? `…${target.slice(-45)}` : target;

  const pathsCount = Array.isArray(parsed?.paths) ? parsed.paths.length : 0;
  const oldPath = getStr("oldPath");
  const newPath = getStr("newPath");
  const fromNote = getStr("from");
  const toNote = getStr("to");
  const sourceNote = getStr("source");
  const targetNote = getStr("target");

  const labelMap: Record<string, string> = {
    search_vault: shortTarget ? `Search vault: "${shortTarget}"` : "Search vault",
    list_folders_and_files: shortTarget ? `Browse "${shortTarget}"` : "Browse vault",
    list_notes: shortTarget ? `List notes in "${shortTarget}"` : "List notes",
    read_note: shortTarget ? `Read "${shortTarget}"` : "Read note",
    read_notes: pathsCount > 0 ? `Read ${pathsCount} notes` : "Read notes batch",
    create_note: shortTarget ? `Create "${shortTarget}"` : "Create note",
    append_to_note: shortTarget ? `Append to "${shortTarget}"` : "Append to note",
    patch_note: shortTarget ? `Patch "${shortTarget}"` : "Patch note",
    replace_note_content: shortTarget ? `Update "${shortTarget}"` : "Update note",
    rename_or_move_note:
      newPath && oldPath
        ? `Move "${oldPath}" → "${newPath}"`
        : "Move / rename note",
    delete_note: shortTarget ? `Delete "${shortTarget}"` : "Delete note",
    create_folder: shortTarget ? `Create folder "${shortTarget}"` : "Create folder",
    rename_or_move_folder:
      newPath && oldPath
        ? `Move folder "${oldPath}" → "${newPath}"`
        : "Move / rename folder",
    delete_folder: shortTarget ? `Delete folder "${shortTarget}"` : "Delete folder",
    get_active_note: "Read active note",
    get_workspace_state: "Inspect workspace tabs",
    open_note_in_workspace: shortTarget ? `Open "${shortTarget}"` : "Open note",
    close_workspace_tab: shortTarget ? `Close tab "${shortTarget}"` : "Close workspace tab",
    edit_active_editor: "Edit active editor",
    open_graph_view: "Open graph view",
    get_graph_neighborhood: shortTarget ? `Inspect graph links: "${shortTarget}"` : "Inspect graph links",
    get_graph_analytics: "Analyze vault graph",
    find_graph_path:
      fromNote && toNote
        ? `Find graph path: "${fromNote}" → "${toNote}"`
        : "Find graph path",
    connect_notes_in_graph:
      sourceNote && targetNote
        ? `Link "${sourceNote}" → "${targetNote}"`
        : "Connect notes in graph",
  };

  const label =
    labelMap[name] ||
    (shortTarget ? `${name.replace(/_/g, " ")}: ${shortTarget}` : name.replace(/_/g, " "));

  const argsPreview = parsed
    ? truncatePreview(JSON.stringify(parsed, null, 2))
    : truncatePreview(rawArgs || "");

  return {
    label,
    argsPreview: argsPreview && argsPreview !== "{}" ? argsPreview : undefined,
  };
}

function formatToolResultPreview(result: string): {
  preview?: string;
  isError: boolean;
} {
  const trimmed = (result || "").trim();
  const lower = trimmed.toLowerCase();
  const isError =
    lower.startsWith("error") ||
    lower.startsWith("❌") ||
    lower.startsWith("tool execution error") ||
    lower.startsWith("failed to") ||
    lower.startsWith("loop detected:") ||
    /"error"\s*:/.test(lower.slice(0, 120));

  return {
    preview: truncatePreview(trimmed) || undefined,
    isError,
  };
}

class ApiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

const READ_ONLY_COMPACTABLE_TOOLS = new Set([
  "read_note",
  "read_notes",
  "search_vault",
  "list_notes",
  "list_folders_and_files",
  "get_active_note",
  "get_workspace_state",
  "get_graph_neighborhood",
  "get_graph_analytics",
  "find_graph_path",
]);

function parseRetryAfterMs(headerVal?: string | null): number | undefined {
  if (!headerVal) return undefined;
  const trimmed = headerVal.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), 60000);
  }
  return undefined;
}

function isRetryableApiError(err: unknown, signal?: AbortSignal): boolean {
  if (isCancellationError(err, signal)) return false;
  if (err instanceof ApiHttpError) {
    return (
      err.status === 429 ||
      err.status === 408 ||
      err.status === 500 ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 504 ||
      err.status === 529
    );
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("rate limit") ||
      msg.includes("too many requests") ||
      msg.includes("overloaded") ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("network") ||
      msg.includes("failed to fetch") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      /\bstatus\s*(408|429|500|502|503|504|529)\b/.test(msg)
    );
  }
  return false;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Generation was cancelled."));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Error("Generation was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Keeps the most recent tool outputs intact while compacting older read-only tool
 * outputs so multi-step API turns stay fast and avoid TPM/context blowup.
 */
function compactToolHistoryMessages(
  messages: ChatMessage[],
  keepRecentToolCount: number = 6
): ChatMessage[] {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      toolIndices.push(i);
    }
  }
  if (toolIndices.length <= keepRecentToolCount) {
    return messages;
  }

  const preserveFrom = new Set(toolIndices.slice(-keepRecentToolCount));
  return messages.map((msg, idx) => {
    if (msg.role !== "tool" || preserveFrom.has(idx)) {
      return msg;
    }
    const toolName = msg.name || "";
    const content = msg.content || "";
    if (!READ_ONLY_COMPACTABLE_TOOLS.has(toolName) || content.length <= 550) {
      return msg;
    }
    const snippet = content.slice(0, 260).trimEnd();
    return {
      ...msg,
      content: `${snippet}\n... [Compacted earlier "${toolName}" output (${content.length} chars) to conserve API tokens; re-read if exact details are needed again.]`,
    };
  });
}

function cleanProseDashes(markdown: string): string {
  if (!markdown) return markdown;

  const sanitizeInlineProse = (segment: string): string => {
    let out = segment
      // Punctuation already before dash: "Wait. — Then" -> "Wait. Then"
      .replace(/([.!?,:;])\s*[—–]\s*/g, "$1 ")
      // Spaced or unspaced em-dash between words/clauses: "word — word" or "word—word" -> "word, word"
      .replace(/([A-Za-z0-9)"'\]])\s*—\s*([A-Za-z0-9("'[ ])/g, "$1, $2")
      // Catch any remaining spaced em-dash
      .replace(/\s+—\s+/g, ", ")
      // Spaced en-dash in prose (avoid numeric ranges like 10–20): "word – word" -> "word, word"
      .replace(/([A-Za-z)"'\]])\s+–\s+([A-Za-z("'[ ])/g, "$1, $2")
      // Spaced hyphen used as a clause separator: "word - word" -> "word, word"
      .replace(/([A-Za-z)"'\]])\s+-\s+([A-Za-z("'[ ])/g, "$1, $2");

    // Clean accidental double spaces or ", ," artifacts
    out = out.replace(/,\s*,+/g, ",");
    return out;
  };

  // Split by inline code spans, wikilinks [[...]], and markdown links [text](url) so we never corrupt code or links
  const sanitizeLineBody = (body: string): string => {
    const parts = body.split(/(`[^`\n]*`|\[\[[^\]\n]+\]\]|\[[^\]]*\]\([^)\n]+\))/g);
    return parts
      .map((part, idx) => (idx % 2 === 1 ? part : sanitizeInlineProse(part)))
      .join("");
  };

  const lines = markdown.split("\n");
  let inFence = false;
  let fenceChar = "";

  const processed = lines.map((line) => {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const markerChar = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = markerChar;
      } else if (markerChar === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      return line;
    }

    if (inFence) return line;

    // Preserve horizontal rules (---, ***, ___) and markdown table divider rows (| --- | :---: |)
    if (
      /^([-*_])(\s*\1){2,}$/.test(trimmed) ||
      /^\|?[\s:-]+\|[\s|:-]*$/.test(trimmed)
    ) {
      return line;
    }

    // Preserve leading list markers ("- ", "* ", "+ ", "1. ") or blockquote prefixes ("> ")
    const prefixMatch = line.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+)(.*)$/);
    if (prefixMatch) {
      return `${prefixMatch[1]}${sanitizeLineBody(prefixMatch[2])}`;
    }

    return sanitizeLineBody(line);
  });

  return processed.join("\n");
}

function isCancellationError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    msg.includes("cancelled") ||
    msg.includes("aborted")
  );
}

function isMutationIntent(prompt: string): boolean {
  const lower = (prompt || "").toLowerCase();
  return (
    /\b(fix|resolve|correct|edit|update|change|modify|replace|patch|rewrite|delete|remove|insert|append|add to|clean up|format)\b/.test(
      lower
    ) ||
    lower.includes("typo") ||
    lower.includes("mistake") ||
    lower.includes("error in") ||
    lower.includes("make the change") ||
    lower.includes("apply this") ||
    lower.includes("apply change") ||
    lower.includes("fix this") ||
    lower.includes("fix the") ||
    lower.includes("fix it")
  );
}

function claimsUnexecutedAction(responseContent: string): boolean {
  const lower = (responseContent || "").toLowerCase();
  return (
    /\b(i('ve| have)? (fixed|resolved|updated|modified|changed|corrected|replaced|patched|applied|removed|deleted|added))\b/.test(
      lower
    ) ||
    /\b(i made the (changes|fixes|edits))\b/.test(lower) ||
    /\b(the (changes|fixes|updates) have been (made|applied))\b/.test(lower) ||
    /\b(here (is|are) the (updated|fixed|corrected) (note|version|text))\b/.test(
      lower
    ) ||
    lower.includes("i've made the changes") ||
    lower.includes("i have made the changes") ||
    lower.includes("i've resolved the issue") ||
    lower.includes("i have resolved the issue") ||
    lower.includes("changes have been applied") ||
    lower.includes("i fixed the typo") ||
    lower.includes("i've fixed the typo")
  );
}

export class UnifiedAIClient {
  private unsupportedReasoningModels = new Set<string>();

  constructor(
    private settings: AISidepanelSettings,
    private toolExecutor: VaultToolExecutor
  ) {}

  public updateSettings(settings: AISidepanelSettings): void {
    this.settings = settings;
  }

  private getEffectiveSystemPrompt(): string {
    let prompt = (this.settings.systemPrompt || "").trim();

    if (
      this.settings.enableVaultTools &&
      !prompt.includes("CRITICAL ACTION MANDATE") &&
      !prompt.includes("CORE ACTION MANDATE")
    ) {
      const actionMandate = `CRITICAL ACTION MANDATE:
When the user asks you to fix, edit, update, modify, rewrite, correct, patch, append, create, or delete notes or workspace content:
1. You MUST call the corresponding vault tool (such as patch_note, replace_note_content, edit_active_editor, append_to_note, or create_note) to execute the modification.
2. NEVER merely describe or claim in conversational text that you have made, fixed, or applied changes without having executed the actual tool call in that turn. Saying "I have fixed the issue" without invoking a tool does NOT change the user's note in Obsidian. Always execute the tool FIRST so the change is applied live in Obsidian.
3. For existing notes, use the exact target path from the context (e.g. path="Folder/Note.md").`;
      prompt = prompt ? `${prompt}\n\n${actionMandate}` : actionMandate;
    }

    if (!prompt.includes("FORMATTING & STYLE")) {
      const styleGuide = `FORMATTING & STYLE:
- Write in clean, natural prose. Avoid em-dashes (—), en-dashes (–), and spaced hyphens ( - ) between clauses; use commas, periods, colons, or parentheses instead.
- Keep Markdown tables compact (2–4 short columns with concise cell values) so they fit cleanly in a narrow sidepanel; prefer structured bullet lists for longer multi-sentence comparisons.`;
      prompt = prompt ? `${prompt}\n\n${styleGuide}` : styleGuide;
    }

    return prompt;
  }

  private getThinkingBudgetTokens(
    effort: ReasoningEffort,
    provider: "anthropic" | "gemini" | "qwen"
  ): number {
    if (provider === "anthropic") {
      switch (effort) {
        case "low":
          return 2048;
        case "medium":
          return 8192;
        case "high":
          return 16384;
        case "max":
          return 32768;
      }
    }
    if (provider === "gemini") {
      switch (effort) {
        case "low":
          return 1024;
        case "medium":
          return 8192;
        case "high":
          return 16384;
        case "max":
          return 24576;
      }
    }
    // qwen / dashscope
    switch (effort) {
      case "low":
        return 1024;
      case "medium":
        return 4096;
      case "high":
        return 16384;
      case "max":
        return 32768;
    }
  }

  private isReasoningParamError(message: string): boolean {
    const lower = (message || "").toLowerCase();
    return (
      lower.includes("reasoning_effort") ||
      lower.includes("reasoning") ||
      lower.includes("enable_thinking") ||
      lower.includes("thinking_budget") ||
      lower.includes("thinkingconfig") ||
      lower.includes("thinkingbudget") ||
      lower.includes("thinking") ||
      lower.includes("temperature")
    );
  }

  /**
   * Runs an agent turn. If tool calling is enabled, executes tools autonomously across
   * checkpoints (with automatic progress handoff & history compaction) until done.
   */
  public async chat(
    conversation: ChatMessage[],
    callbacks: StreamCallbacks
  ): Promise<ChatMessage> {
    this.toolExecutor.beginTurn();

    const maxIterationsPerCheckpoint = this.settings.enableVaultTools
      ? Math.max(1, this.settings.maxToolIterations || 25)
      : 1;
    const autoContinueEnabled =
      this.settings.enableVaultTools &&
      this.settings.autoContinueTasks !== false;
    const maxCheckpoints = autoContinueEnabled ? 5 : 1;

    let currentMessages = [...conversation];
    let checkpoint = 0;
    let totalStepsExecuted = 0;
    let lastToolSignature = "";
    let consecutiveDuplicateCount = 0;
    const turnActivities: ToolActivityRecord[] = [];
    let turnReasoning = "";

    const attachTurnTrace = (msg: ChatMessage): ChatMessage => {
      if (msg.content) {
        msg.content = cleanProseDashes(msg.content);
      }
      if (turnActivities.length > 0) {
        msg.toolActivities = turnActivities;
      }
      const trimmedReasoning = turnReasoning.trim();
      if (trimmedReasoning) {
        msg.reasoningContent = truncatePreview(
          trimmedReasoning,
          MAX_REASONING_STORAGE_CHARS
        );
      }
      return msg;
    };

    const makeReasoningCallbacks = (suppressChunks: boolean): StreamCallbacks => {
      let iterationStartedReasoning = false;
      return {
        ...callbacks,
        onChunk: suppressChunks ? () => {} : callbacks.onChunk,
        onReasoningChunk: (text: string) => {
          if (!text) return;
          if (!iterationStartedReasoning && turnReasoning.length > 0) {
            const sep = "\n\n";
            turnReasoning += sep;
            callbacks.onReasoningChunk?.(sep);
          }
          iterationStartedReasoning = true;
          turnReasoning += text;
          callbacks.onReasoningChunk?.(text);
        },
      };
    };

    while (checkpoint < maxCheckpoints) {
      checkpoint++;
      let iteration = 0;
      let checkpointProgressSteps = 0;
      let checkpointLoopBlocked = false;

      while (iteration < maxIterationsPerCheckpoint) {
        iteration++;

        if (callbacks.signal?.aborted) {
          throw new Error("Generation was cancelled.");
        }

        const compactedMessages = compactToolHistoryMessages(currentMessages);
        const response = await this.callProviderWithRetry(
          compactedMessages,
          makeReasoningCallbacks(false),
          false
        );

        // Check if tool calls were requested
        if (
          this.settings.enableVaultTools &&
          response.tool_calls &&
          response.tool_calls.length > 0
        ) {
          currentMessages.push(response);

          const batchSignature = response.tool_calls
            .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
            .join("|");

          if (batchSignature === lastToolSignature) {
            consecutiveDuplicateCount++;
          } else {
            lastToolSignature = batchSignature;
            consecutiveDuplicateCount = 1;
          }

          if (consecutiveDuplicateCount >= 3) {
            checkpointLoopBlocked = true;
            for (const toolCall of response.tool_calls) {
              const desc = describeToolCall(
                toolCall.function.name,
                toolCall.function.arguments
              );
              const skipActivity: ToolActivityRecord = {
                id: `${toolCall.id || toolCall.function.name}_loop_${turnActivities.length}`,
                name: toolCall.function.name,
                label: `Skipped repeat: ${desc.label}`,
                argsPreview: desc.argsPreview,
                resultPreview:
                  "Loop detected; asked assistant to move to the next step.",
                status: "error",
                startedAt: Date.now(),
                durationMs: 0,
              };
              turnActivities.push(skipActivity);
              callbacks.onToolActivity?.({ ...skipActivity });

              currentMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
                content: `Loop detected: "${toolCall.function.name}" was already called repeatedly with identical arguments. Do NOT repeat it again. Proceed to the next step, try a different approach, or provide your final answer.`,
              });
            }
            callbacks.onReset?.();
            callbacks.onStatus?.("Breaking tool loop...");
            continue;
          }

          checkpointLoopBlocked = false;

          for (const toolCall of response.tool_calls) {
            if (callbacks.signal?.aborted) {
              throw new Error("Generation was cancelled.");
            }

            const desc = describeToolCall(
              toolCall.function.name,
              toolCall.function.arguments
            );
            const activity: ToolActivityRecord = {
              id: `${toolCall.id || toolCall.function.name}_${turnActivities.length}`,
              name: toolCall.function.name,
              label: desc.label,
              argsPreview: desc.argsPreview,
              status: "running",
              startedAt: Date.now(),
            };
            turnActivities.push(activity);
            callbacks.onToolActivity?.({ ...activity });

            const cpPrefix =
              checkpoint > 1 ? `[Batch ${checkpoint}] ` : "";
            callbacks.onStatus?.(
              `${cpPrefix}${desc.label} (${iteration}/${maxIterationsPerCheckpoint})...`
            );

            let result = "";
            try {
              result = await this.toolExecutor.executeTool(
                toolCall.function.name,
                toolCall.function.arguments,
                callbacks.onStatus
              );
              const formatted = formatToolResultPreview(result);
              activity.status = formatted.isError ? "error" : "completed";
              activity.resultPreview = formatted.preview;
            } catch (toolErr: unknown) {
              activity.status = "error";
              const errMsg =
                toolErr instanceof Error ? toolErr.message : String(toolErr);
              activity.resultPreview = truncatePreview(errMsg);
              activity.durationMs = Date.now() - activity.startedAt;
              callbacks.onToolActivity?.({ ...activity });
              throw toolErr;
            }

            checkpointProgressSteps++;
            totalStepsExecuted++;
            activity.durationMs = Date.now() - activity.startedAt;
            callbacks.onToolActivity?.({ ...activity });

            currentMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: result,
            });
          }

          // Gently remind model near end of batch so it batches/finishes cleanly
          if (iteration === maxIterationsPerCheckpoint - 2) {
            currentMessages.push({
              role: "user",
              content:
                "SYSTEM NOTE: Only 2 tool steps remain in this checkpoint batch. Wrap up current edits cleanly or batch remaining reads.",
            });
          }

          callbacks.onReset?.();
          callbacks.onStatus?.("Synthesizing response...");
          continue;
        }

        // Check if the model claimed to have fixed or modified a note without calling tools
        if (
          checkpoint === 1 &&
          iteration === 1 &&
          this.settings.enableVaultTools &&
          (!response.tool_calls || response.tool_calls.length === 0) &&
          this.toolExecutor.getTurnChanges().length === 0
        ) {
          const lastUserMsg = conversation
            .filter((m) => m.role === "user")
            .pop();
          const userPromptText = lastUserMsg?.content || "";
          if (
            isMutationIntent(userPromptText) &&
            claimsUnexecutedAction(response.content)
          ) {
            callbacks.onReset?.();
            callbacks.onStatus?.(
              "Applying changes directly to note in Obsidian..."
            );
            currentMessages.push(response);
            currentMessages.push({
              role: "user",
              content:
                "SYSTEM ACTION REQUIRED: You described fixing, updating, or modifying the note, but you did NOT call any vault tool (such as patch_note, replace_note_content, or edit_active_editor). The note in Obsidian has NOT been updated! You must call the appropriate tool right now to actually execute and apply these changes to the note in Obsidian.",
            });
            continue;
          }
        }

        // No tool calls; task completed!
        const changes = this.toolExecutor.getAndClearTurnChanges();
        if (changes.length > 0) {
          response.noteChanges = changes;
        }
        return attachTurnTrace(response);
      }

      // Checkpoint reached! Auto-continue with compact progress handoff if allowed & making progress
      if (
        checkpoint < maxCheckpoints &&
        checkpointProgressSteps > 0 &&
        !checkpointLoopBlocked
      ) {
        callbacks.onReset?.();
        callbacks.onStatus?.(
          `Checkpoint ${checkpoint} reached (${totalStepsExecuted} steps) — compacting context & continuing...`
        );

        const handoffMessages = [
          ...compactToolHistoryMessages(currentMessages, 4),
          {
            role: "user" as const,
            content:
              "CHECKPOINT HANDOFF: Create a concise, factual state handoff (do NOT call tools now). List: 1) Notes/folders already inspected or modified, 2) Exact changes already applied, 3) Exact remaining items/steps still needed to finish the user's request.",
          },
        ];

        let handoffSummary = "";
        try {
          const handoffMsg = await this.callProviderWithRetry(
            handoffMessages,
            makeReasoningCallbacks(true),
            true
          );
          handoffSummary = (handoffMsg.content || "").trim();
        } catch (handoffErr) {
          if (isCancellationError(handoffErr, callbacks.signal)) {
            throw handoffErr;
          }
        }

        const modifiedPaths = Array.from(
          new Set(
            this.toolExecutor
              .getTurnChanges()
              .map((c) => `${c.type}: ${c.path}`)
          )
        );
        const handoffBlock =
          handoffSummary ||
          `Completed ${totalStepsExecuted} tool steps so far.${
            modifiedPaths.length > 0
              ? ` Vault changes applied: ${modifiedPaths.join(", ")}.`
              : ""
          }`;

        const cpActivity: ToolActivityRecord = {
          id: `checkpoint_${checkpoint}_${Date.now()}`,
          name: "checkpoint_handoff",
          label: `Checkpoint ${checkpoint} complete — auto-continuing`,
          resultPreview: truncatePreview(handoffBlock),
          status: "completed",
          startedAt: Date.now(),
          durationMs: 0,
        };
        turnActivities.push(cpActivity);
        callbacks.onToolActivity?.({ ...cpActivity });

        // Compact history to original conversation + structured progress handoff
        currentMessages = [
          ...conversation,
          {
            role: "assistant",
            content: `[Checkpoint ${checkpoint} Progress Summary]\n${handoffBlock}`,
          },
          {
            role: "user",
            content:
              "Continue seamlessly from this checkpoint using vault tools until the entire task is complete. Do NOT re-do completed work.",
          },
        ];
        lastToolSignature = "";
        consecutiveDuplicateCount = 0;
        callbacks.onStatus?.(
          `Auto-continuing task (checkpoint ${checkpoint + 1}/${maxCheckpoints})...`
        );
        continue;
      }

      // Break to final user-facing synthesis (maxCheckpoints reached, auto-continue off, or stalled)
      break;
    }

    // Graceful final synthesis when step/checkpoint limit is reached so progress isn't lost
    callbacks.onReset?.();
    callbacks.onStatus?.("Summarizing progress (checkpoint limit reached)...");
    const summaryMessages = [
      ...compactToolHistoryMessages(currentMessages, 6),
      {
        role: "user" as const,
        content:
          "You have reached the autonomous step limit for this run. Do NOT attempt any more tool calls. Clearly summarize what you have completed, any changes made, and what remains if the task is not yet finished.",
      },
    ];

    try {
      const finalSummary = await this.callProviderWithRetry(
        summaryMessages,
        makeReasoningCallbacks(false),
        true
      );
      const turnChanges = this.toolExecutor.getAndClearTurnChanges();
      if (turnChanges.length > 0) {
        finalSummary.noteChanges = turnChanges;
      }
      finalSummary.hitToolLimit = true;
      return attachTurnTrace(finalSummary);
    } catch (synthErr) {
      if (isCancellationError(synthErr, callbacks.signal)) {
        throw synthErr;
      }
      const fallbackChanges = this.toolExecutor.getAndClearTurnChanges();
      return attachTurnTrace({
        role: "assistant",
        content: `Paused after ${totalStepsExecuted} tool steps across ${checkpoint} checkpoint(s). Click **Continue Task** below to resume right where I left off.`,
        noteChanges: fallbackChanges.length > 0 ? fallbackChanges : undefined,
        hitToolLimit: true,
      });
    }
  }

  private async callProviderWithRetry(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    disableTools: boolean = false
  ): Promise<ChatMessage> {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.callProvider(messages, callbacks, disableTools);
      } catch (err: unknown) {
        if (
          attempt >= maxRetries ||
          !isRetryableApiError(err, callbacks.signal)
        ) {
          throw err;
        }
        const retryAfterMs =
          err instanceof ApiHttpError ? err.retryAfterMs : undefined;
        const backoffMs = Math.min(
          Math.max(retryAfterMs ?? 0, 1500 * Math.pow(2, attempt)) +
            Math.floor(Math.random() * 450),
          35000
        );
        const waitSec = Math.max(1, Math.ceil(backoffMs / 1000));
        const reason =
          err instanceof ApiHttpError && err.status === 429
            ? "API rate limit (429)"
            : err instanceof ApiHttpError
              ? `API error (${err.status})`
              : "Temporary connection issue";
        callbacks.onReset?.();
        callbacks.onStatus?.(
          `${reason} — retrying in ${waitSec}s (attempt ${attempt + 2}/${maxRetries + 1})...`
        );
        await sleepWithAbort(backoffMs, callbacks.signal);
      }
    }
    throw new Error("API request failed after retries.");
  }

  private async callProvider(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    disableTools: boolean = false
  ): Promise<ChatMessage> {
    const protocol = inferProtocolFromBaseUrl(this.settings.baseUrl);
    switch (protocol) {
      case "anthropic":
        return await this.callAnthropic(messages, callbacks, disableTools);
      case "gemini":
        return await this.callGemini(messages, callbacks, disableTools);
      case "openai-compatible":
      default:
        return await this.callOpenAICompatible(messages, callbacks, disableTools);
    }
  }

  /**
   * Executes an SSE POST request via Obsidian's `requestUrl` and yields each parsed `data:` payload.
   */
  private async streamSSE(
    endpoint: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal | undefined,
    providerLabel: string,
    onData: (dataStr: string) => boolean | void
  ): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Generation was cancelled.");
    }

    const res = await requestUrl({
      url: endpoint,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });

    if (signal?.aborted) {
      throw new Error("Generation was cancelled.");
    }

    if (res.status >= 400) {
      const retryAfterMs = parseRetryAfterMs(res.headers?.["retry-after"]);
      throw new ApiHttpError(
        `${providerLabel} Error ${res.status}: ${res.text}`,
        res.status,
        retryAfterMs
      );
    }

    const rawText = res.text || "";
    if (!rawText.trim()) {
      throw new Error("No response body received from server.");
    }

    const processLine = (rawLine: string): boolean => {
      const trimmed = rawLine.trim();
      if (!trimmed || !trimmed.startsWith("data:")) return false;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) return false;
      if (dataStr === "[DONE]") return true;
      return onData(dataStr) === true;
    };

    let processedAny = false;
    for (const line of rawText.split(/\r?\n/)) {
      if (signal?.aborted) {
        throw new Error("Generation was cancelled.");
      }
      if (line.trim().startsWith("data:")) {
        processedAny = true;
      }
      if (processLine(line)) return;
    }

    if (!processedAny) {
      // Some endpoints return a single JSON response even when stream: true is passed
      onData(rawText.trim());
    }
  }

  // ==========================================
  // OpenAI-Compatible (OpenAI, OpenRouter, Groq, Ollama, DeepSeek)
  // ==========================================
  private async callOpenAICompatible(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    disableTools: boolean = false
  ): Promise<ChatMessage> {
    let baseUrl = (this.settings.baseUrl || "https://api.openai.com/v1").replace(
      /\/+$/,
      ""
    );
    const endpoint = baseUrl.endsWith("/chat/completions")
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.settings.apiKey && this.settings.apiKey.trim()) {
      headers["Authorization"] = `Bearer ${this.settings.apiKey.trim()}`;
    }

    if (baseUrl.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = "https://obsidian.md";
      headers["X-Title"] = "Obsidian AI Sidepanel";
    }

    // Format tools
    const tools =
      !disableTools && this.settings.enableVaultTools
        ? VAULT_TOOL_DEFINITIONS.map((def) => ({
          type: "function",
          function: {
            name: def.name,
            description: def.description,
            parameters: def.parameters,
          },
        }))
      : undefined;

    // Format messages: ensure system prompt is included
    const apiMessages: Array<Record<string, unknown>> = [];
    const effectiveSystemPrompt = this.getEffectiveSystemPrompt();
    if (effectiveSystemPrompt) {
      apiMessages.push({
        role: "system",
        content: effectiveSystemPrompt,
      });
    }

    for (const m of messages) {
      const msgObj: Record<string, unknown> = {
        role: m.role,
        content: m.content || "",
      };
      if (m.tool_calls) msgObj.tool_calls = m.tool_calls;
      if (m.tool_call_id) msgObj.tool_call_id = m.tool_call_id;
      if (m.name) msgObj.name = m.name;
      apiMessages.push(msgObj);
    }

    const modelId = this.settings.model || "gpt-4o-mini";
    const baseModel = normalizeModelBaseId(modelId);
    const payload: Record<string, unknown> = {
      model: modelId,
      messages: apiMessages,
      temperature: this.settings.temperature ?? 0.7,
      stream: true,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
    }

    const reasoningCap = getActiveModelReasoningCapability(this.settings);
    let injectedReasoning = false;
    if (reasoningCap.supported && !this.unsupportedReasoningModels.has(modelId)) {
      const effort: ReasoningEffort = this.settings.reasoningEffort || "medium";
      if (baseUrl.includes("openrouter.ai")) {
        payload.reasoning = { effort: effort === "max" ? "high" : effort };
        injectedReasoning = true;
      } else if (reasoningCap.mode === "qwen_thinking") {
        payload.enable_thinking = true;
        payload.thinking_budget = this.getThinkingBudgetTokens(effort, "qwen");
        injectedReasoning = true;
      } else {
        payload.reasoning_effort = effort === "max" ? "high" : effort;
        injectedReasoning = true;
      }

      // OpenAI o1/o3/o4 reasoning models reject non-default temperature
      if (/^o[134]($|-)/.test(baseModel)) {
        delete payload.temperature;
      }
    }

    try {
      return await this.streamOpenAIResponse(endpoint, headers, payload, callbacks);
    } catch (err: unknown) {
      if (isCancellationError(err, callbacks.signal)) {
        throw new Error("Generation was cancelled.");
      }
      if (err instanceof ApiHttpError) {
        if (
          err.status === 400 &&
          injectedReasoning &&
          this.isReasoningParamError(err.message)
        ) {
          this.unsupportedReasoningModels.add(modelId);
          const cleanPayload: Record<string, unknown> = { ...payload };
          delete cleanPayload.reasoning_effort;
          delete cleanPayload.reasoning;
          delete cleanPayload.enable_thinking;
          delete cleanPayload.thinking_budget;
          return await this.streamOpenAIResponse(
            endpoint,
            headers,
            cleanPayload,
            callbacks
          );
        }
        throw err;
      }
      return await this.fallbackOpenAIRequestUrl(
        endpoint,
        headers,
        payload,
        callbacks
      );
    }
  }

  private async streamOpenAIResponse(
    endpoint: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
    callbacks: StreamCallbacks
  ): Promise<ChatMessage> {
    let accumulatedText = "";
    const toolCallsMap: { [index: number]: ToolCall } = {};

    interface OpenAIStreamPayload {
      choices?: Array<{
        delta?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
        message?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: ToolCall[];
        };
      }>;
    }

    await this.streamSSE(
      endpoint,
      headers,
      payload,
      callbacks.signal,
      "API",
      (dataStr) => {
        let json: OpenAIStreamPayload;
        try {
          json = JSON.parse(dataStr) as OpenAIStreamPayload;
        } catch {
          return;
        }

        const choice = json.choices?.[0];
        if (!choice) return;

        // Reasoning / thinking delta (DeepSeek, OpenRouter, Qwen, etc.)
        const reasoningDelta =
          choice.delta?.reasoning_content ??
          choice.delta?.reasoning ??
          choice.message?.reasoning_content ??
          choice.message?.reasoning;
        if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
          callbacks.onReasoningChunk?.(reasoningDelta);
        }

        // Content delta
        const contentDelta = choice.delta?.content ?? choice.message?.content;
        if (contentDelta) {
          accumulatedText += contentDelta;
          callbacks.onChunk(contentDelta);
        }

        // Non-streaming tool calls if endpoint returned full message object
        if (choice.message?.tool_calls && !choice.delta?.tool_calls) {
          choice.message.tool_calls.forEach((tc, idx) => {
            toolCallsMap[idx] = tc;
          });
        }

        // Tool call delta
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = {
                id: tc.id || `call_${Date.now()}_${idx}`,
                type: "function",
                function: {
                  name: tc.function?.name || "",
                  arguments: tc.function?.arguments || "",
                },
              };
            } else {
              if (tc.function?.name) {
                toolCallsMap[idx].function.name += tc.function.name;
              }
              if (tc.function?.arguments) {
                toolCallsMap[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    );

    const toolCalls = Object.values(toolCallsMap);
    return {
      role: "assistant",
      content: accumulatedText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private async fallbackOpenAIRequestUrl(
    endpoint: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
    callbacks: StreamCallbacks
  ): Promise<ChatMessage> {
    const nonStreamPayload: Record<string, unknown> = {
      ...payload,
      stream: false,
    };
    const modelStr =
      typeof payload.model === "string" ? payload.model.toLowerCase() : "";
    if (endpoint.includes("dashscope") || modelStr.includes("qwen3")) {
      nonStreamPayload.enable_thinking = false;
    }
    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      headers,
      body: JSON.stringify(nonStreamPayload),
    });

    if (response.status >= 400) {
      throw new ApiHttpError(
        `API Error ${response.status}: ${response.text}`,
        response.status,
        parseRetryAfterMs(response.headers?.["retry-after"])
      );
    }

    const json = (response.json as unknown) as {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: ToolCall[];
        };
      }>;
    } | null;
    const choice = json?.choices?.[0];
    const message = choice?.message;
    const reasoningText = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoningText === "string" && reasoningText.length > 0) {
      callbacks.onReasoningChunk?.(reasoningText);
    }
    const content = message?.content || "";
    if (content) {
      callbacks.onChunk(content);
    }
    return {
      role: "assistant",
      content,
      tool_calls: message?.tool_calls,
    };
  }

  // ==========================================
  // Anthropic Provider
  // ==========================================
  private async callAnthropic(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    disableTools: boolean = false
  ): Promise<ChatMessage> {
    const baseUrl = (this.settings.baseUrl || "https://api.anthropic.com")
      .replace(/\/v1\/messages$/, "")
      .replace(/\/v1$/, "")
      .replace(/\/+$/, "");
    const endpoint = `${baseUrl}/v1/messages`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.settings.apiKey || "",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };

    // Tools for Anthropic
    const tools =
      !disableTools && this.settings.enableVaultTools
        ? VAULT_TOOL_DEFINITIONS.map((def) => ({
          name: def.name,
          description: def.description,
          input_schema: def.parameters,
        }))
      : undefined;

    // Convert chat messages to Anthropic format
    const anthropicMessages: Array<Record<string, unknown>> = [];
    for (const m of messages) {
      if (m.role === "system") continue; // handled via system field
      if (m.role === "tool") {
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id || "call_unknown",
              content: m.content,
            },
          ],
        });
      } else if (m.role === "assistant" && m.tool_calls) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (m.content) {
          contentBlocks.push({ type: "text", text: m.content });
        }
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            const parsedInput: unknown = JSON.parse(tc.function.arguments);
            if (
              parsedInput &&
              typeof parsedInput === "object" &&
              !Array.isArray(parsedInput)
            ) {
              input = parsedInput as Record<string, unknown>;
            }
          } catch {
            // Keep empty object if tool arguments were malformed JSON
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: input,
          });
        }
        anthropicMessages.push({
          role: "assistant",
          content: contentBlocks,
        });
      } else {
        anthropicMessages.push({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
        });
      }
    }

    const modelId = this.settings.model || "claude-3-5-sonnet-20241022";
    const effectiveSystemPrompt = this.getEffectiveSystemPrompt();
    const maxTokensBase = this.settings.maxTokens || 4096;
    const payload: Record<string, unknown> = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: maxTokensBase,
      temperature: this.settings.temperature ?? 0.7,
      system: effectiveSystemPrompt || undefined,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
    }

    const reasoningCap = getActiveModelReasoningCapability(this.settings);
    let injectedThinking = false;
    if (reasoningCap.supported && !this.unsupportedReasoningModels.has(modelId)) {
      const effort: ReasoningEffort = this.settings.reasoningEffort || "medium";
      const budget = this.getThinkingBudgetTokens(effort, "anthropic");
      payload.thinking = { type: "enabled", budget_tokens: budget };
      payload.max_tokens = Math.max(maxTokensBase, budget + 4096);
      // Anthropic forbids custom temperature when extended thinking is enabled
      delete payload.temperature;
      injectedThinking = true;
    }

    try {
      return await this.streamAnthropicResponse(
        endpoint,
        headers,
        { ...payload, stream: true },
        callbacks
      );
    } catch (err: unknown) {
      if (isCancellationError(err, callbacks.signal)) {
        throw new Error("Generation was cancelled.");
      }
      if (err instanceof ApiHttpError) {
        if (
          err.status === 400 &&
          injectedThinking &&
          this.isReasoningParamError(err.message)
        ) {
          this.unsupportedReasoningModels.add(modelId);
          const cleanPayload: Record<string, unknown> = {
            ...payload,
            temperature: this.settings.temperature ?? 0.7,
            max_tokens: this.settings.maxTokens || 4096,
            stream: true,
          };
          delete cleanPayload.thinking;
          return await this.streamAnthropicResponse(
            endpoint,
            headers,
            cleanPayload,
            callbacks
          );
        }
        throw err;
      }
      return await this.fallbackAnthropicRequestUrl(
        endpoint,
        headers,
        payload,
        callbacks
      );
    }
  }

  private async streamAnthropicResponse(
    endpoint: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
    callbacks: StreamCallbacks
  ): Promise<ChatMessage> {
    let accumulatedText = "";
    const toolCallsMap: { [index: number]: ToolCall } = {};

    interface AnthropicStreamEvent {
      type?: string;
      index?: number;
      error?: { message?: string };
      content_block?: {
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
      };
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
      };
    }

    await this.streamSSE(
      endpoint,
      headers,
      payload,
      callbacks.signal,
      "Anthropic",
      (dataStr) => {
        let evt: AnthropicStreamEvent;
        try {
          evt = JSON.parse(dataStr) as AnthropicStreamEvent;
        } catch {
          return;
        }

        if (evt.type === "error") {
          throw new ApiHttpError(
            `Anthropic Error: ${evt.error?.message || JSON.stringify(evt.error)}`,
            500
          );
        }

        if (evt.type === "content_block_start") {
          const idx = evt.index ?? 0;
          const block = evt.content_block;
          if (block?.type === "text" && block.text) {
            accumulatedText += block.text;
            callbacks.onChunk(block.text);
          } else if (block?.type === "thinking" && block.thinking) {
            callbacks.onReasoningChunk?.(block.thinking);
          } else if (block?.type === "tool_use") {
            toolCallsMap[idx] = {
              id: block.id || `call_anthropic_${Date.now()}_${idx}`,
              type: "function",
              function: {
                name: block.name || "",
                arguments: "",
              },
            };
          }
        } else if (evt.type === "content_block_delta") {
          const idx = evt.index ?? 0;
          const delta = evt.delta;
          if (delta?.type === "text_delta" && delta.text) {
            accumulatedText += delta.text;
            callbacks.onChunk(delta.text);
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            callbacks.onReasoningChunk?.(delta.thinking);
          } else if (delta?.type === "input_json_delta" && delta.partial_json) {
            if (toolCallsMap[idx]) {
              toolCallsMap[idx].function.arguments += delta.partial_json;
            }
          }
        } else if (evt.type === "message_stop") {
          return true;
        }
      }
    );

    const toolCalls = Object.values(toolCallsMap).map((tc) => ({
      ...tc,
      function: {
        ...tc.function,
        arguments: tc.function.arguments.trim() || "{}",
      },
    }));

    return {
      role: "assistant",
      content: accumulatedText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private async fallbackAnthropicRequestUrl(
    endpoint: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
    callbacks: StreamCallbacks
  ): Promise<ChatMessage> {
    const res = await requestUrl({
      url: endpoint,
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status >= 400) {
      throw new ApiHttpError(
        `Anthropic Error ${res.status}: ${res.text}`,
        res.status,
        parseRetryAfterMs(res.headers?.["retry-after"])
      );
    }

    interface AnthropicContentBlock {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }
    const data = (res.json as unknown) as { content?: AnthropicContentBlock[] } | null;
    let accumulatedText = "";
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(data?.content)) {
      for (const block of data.content) {
        if (block.type === "text" && block.text) {
          accumulatedText += block.text;
          callbacks.onChunk(block.text);
        } else if (block.type === "thinking" && block.thinking) {
          callbacks.onReasoningChunk?.(block.thinking);
        } else if (block.type === "tool_use" && block.name) {
          toolCalls.push({
            id: block.id || `call_anthropic_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }
    }

    return {
      role: "assistant",
      content: accumulatedText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  // ==========================================
  // Google Gemini Provider
  // ==========================================
  private async callGemini(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    disableTools: boolean = false
  ): Promise<ChatMessage> {
    const baseUrl = (
      this.settings.baseUrl || "https://generativelanguage.googleapis.com"
    )
      .replace(/\/v1beta(\/models)?$/, "")
      .replace(/\/+$/, "");
    const model = this.settings.model || "gemini-1.5-flash";
    const endpoint = `${baseUrl}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      this.settings.apiKey || ""
    )}`;

    // Gemini contents
    const contents: Array<Record<string, unknown>> = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        contents.push({
          role: "function",
          parts: [
            {
              functionResponse: {
                name: m.name || "vault_tool",
                response: { result: m.content },
              },
            },
          ],
        });
      } else if (m.role === "assistant" && m.tool_calls) {
        const parts: Array<Record<string, unknown>> = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            const parsedArgs: unknown = JSON.parse(tc.function.arguments);
            if (
              parsedArgs &&
              typeof parsedArgs === "object" &&
              !Array.isArray(parsedArgs)
            ) {
              args = parsedArgs as Record<string, unknown>;
            }
          } catch {
            // Keep empty object if tool arguments were malformed JSON
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
            },
          });
        }
        contents.push({ role: "model", parts });
      } else {
        contents.push({
          role: m.role === "user" ? "user" : "model",
          parts: [{ text: m.content }],
        });
      }
    }

    const generationConfig: Record<string, unknown> = {
      temperature: this.settings.temperature ?? 0.7,
      maxOutputTokens: this.settings.maxTokens || 4096,
    };
    const payload: Record<string, unknown> = {
      contents,
      generationConfig,
    };

    const reasoningCap = getActiveModelReasoningCapability(this.settings);
    let injectedThinking = false;
    if (reasoningCap.supported && !this.unsupportedReasoningModels.has(model)) {
      const effort: ReasoningEffort = this.settings.reasoningEffort || "medium";
      const baseModel = normalizeModelBaseId(model);
      if (baseModel.startsWith("gemini-3")) {
        generationConfig.thinkingConfig = {
          thinkingLevel:
            effort === "low" ? "LOW" : effort === "medium" ? "MEDIUM" : "HIGH",
        };
      } else {
        const budget = this.getThinkingBudgetTokens(effort, "gemini");
        generationConfig.thinkingConfig = {
          thinkingBudget: budget,
        };
        generationConfig.maxOutputTokens = Math.max(
          this.settings.maxTokens || 4096,
          8192
        );
      }
      injectedThinking = true;
    }

    const effectiveSystemPrompt = this.getEffectiveSystemPrompt();
    if (effectiveSystemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: effectiveSystemPrompt }],
      };
    }

    if (!disableTools && this.settings.enableVaultTools) {
      payload.tools = [
        {
          function_declarations: VAULT_TOOL_DEFINITIONS.map((d) => ({
            name: d.name,
            description: d.description,
            parameters: d.parameters,
          })),
        },
      ];
    }

    const streamEndpoint = `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
      this.settings.apiKey || ""
    )}`;

    try {
      return await this.streamGeminiResponse(streamEndpoint, payload, callbacks);
    } catch (err: unknown) {
      if (isCancellationError(err, callbacks.signal)) {
        throw new Error("Generation was cancelled.");
      }
      if (err instanceof ApiHttpError) {
        if (
          err.status === 400 &&
          injectedThinking &&
          this.isReasoningParamError(err.message)
        ) {
          this.unsupportedReasoningModels.add(model);
          const cleanGenConfig: Record<string, unknown> = {
            ...generationConfig,
            maxOutputTokens: this.settings.maxTokens || 4096,
          };
          delete cleanGenConfig.thinkingConfig;
          const cleanPayload: Record<string, unknown> = {
            ...payload,
            generationConfig: cleanGenConfig,
          };
          return await this.streamGeminiResponse(
            streamEndpoint,
            cleanPayload,
            callbacks
          );
        }
        throw err;
      }
      return await this.fallbackGeminiRequestUrl(endpoint, payload, callbacks);
    }
  }

  private async streamGeminiResponse(
    endpoint: string,
    payload: Record<string, unknown>,
    callbacks: StreamCallbacks
  ): Promise<ChatMessage> {
    let accumulatedText = "";
    const toolCalls: ToolCall[] = [];

    interface GeminiPart {
      text?: string;
      thought?: boolean;
      functionCall?: {
        name: string;
        args?: Record<string, unknown>;
      };
    }
    interface GeminiResponsePayload {
      error?: {
        code?: number;
        message?: string;
      };
      candidates?: Array<{
        content?: {
          parts?: GeminiPart[];
        };
      }>;
    }

    await this.streamSSE(
      endpoint,
      { "Content-Type": "application/json" },
      payload,
      callbacks.signal,
      "Gemini",
      (dataStr) => {
        let data: GeminiResponsePayload;
        try {
          data = JSON.parse(dataStr) as GeminiResponsePayload;
        } catch {
          return;
        }

        if (data.error) {
          const errCode = typeof data.error.code === "number" ? data.error.code : 500;
          throw new ApiHttpError(
            `Gemini Error ${errCode}: ${
              data.error.message || JSON.stringify(data.error)
            }`,
            errCode
          );
        }

        const candidate = data.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text && part.thought) {
              callbacks.onReasoningChunk?.(part.text);
            } else if (part.text && !part.thought) {
              accumulatedText += part.text;
              callbacks.onChunk(part.text);
            }
            if (part.functionCall) {
              toolCalls.push({
                id: `call_gemini_${Date.now()}_${toolCalls.length}`,
                type: "function",
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              });
            }
          }
        }
      }
    );

    return {
      role: "assistant",
      content: accumulatedText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private async fallbackGeminiRequestUrl(
    endpoint: string,
    payload: Record<string, unknown>,
    callbacks: StreamCallbacks
  ): Promise<ChatMessage> {
    const res = await requestUrl({
      url: endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.status >= 400) {
      throw new ApiHttpError(
        `Gemini Error ${res.status}: ${res.text}`,
        res.status,
        parseRetryAfterMs(res.headers?.["retry-after"])
      );
    }

    interface GeminiPart {
      text?: string;
      thought?: boolean;
      functionCall?: {
        name: string;
        args?: Record<string, unknown>;
      };
    }
    const data = (res.json as unknown) as {
      candidates?: Array<{
        content?: {
          parts?: GeminiPart[];
        };
      }>;
    } | null;
    const candidate = data?.candidates?.[0];
    let accumulatedText = "";
    const toolCalls: ToolCall[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text && part.thought) {
          callbacks.onReasoningChunk?.(part.text);
        } else if (part.text && !part.thought) {
          accumulatedText += part.text;
          callbacks.onChunk(part.text);
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_gemini_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          });
        }
      }
    }

    return {
      role: "assistant",
      content: accumulatedText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}

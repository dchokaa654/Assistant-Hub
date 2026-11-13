export type AIProvider = "openai-compatible" | "anthropic" | "gemini";

export type ModelCategory = "flagship" | "coding" | "vision" | "fast" | "other";

export const MODEL_CATEGORY_ORDER: ModelCategory[] = [
  "flagship",
  "coding",
  "vision",
  "fast",
  "other",
];

export const MODEL_CATEGORY_META: Record<
  ModelCategory,
  { id: ModelCategory; label: string; shortLabel: string; icon: string }
> = {
  flagship: {
    id: "flagship",
    label: "Flagship & Reasoning",
    shortLabel: "Flagship",
    icon: "sparkles",
  },
  coding: {
    id: "coding",
    label: "Coding Specialists",
    shortLabel: "Coding",
    icon: "code",
  },
  vision: {
    id: "vision",
    label: "Vision & Multimodal",
    shortLabel: "Vision",
    icon: "eye",
  },
  fast: {
    id: "fast",
    label: "Fast & Lightweight",
    shortLabel: "Fast",
    icon: "zap",
  },
  other: {
    id: "other",
    label: "Other Models",
    shortLabel: "Other",
    icon: "cpu",
  },
};

export type ReasoningEffort = "low" | "medium" | "high" | "max";

export const REASONING_EFFORT_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  {
    value: "low",
    label: "Low",
    shortLabel: "Low",
    description: "Minimal thinking budget, fastest replies",
  },
  {
    value: "medium",
    label: "Medium",
    shortLabel: "Med",
    description: "Balanced reasoning depth and latency",
  },
  {
    value: "high",
    label: "High",
    shortLabel: "High",
    description: "Deep step-by-step deliberation",
  },
  {
    value: "max",
    label: "Max",
    shortLabel: "Max",
    description: "Maximum thinking depth / token budget",
  },
];

export type ReasoningParameterMode =
  | "effort"
  | "anthropic_thinking"
  | "gemini_thinking"
  | "qwen_thinking"
  | "none";

export interface ReasoningCapability {
  supported: boolean;
  efforts: ReasoningEffort[];
  mode: ReasoningParameterMode;
}

export interface AttachedModelInfo {
  id: string;
  name: string;
  description?: string;
  category?: ModelCategory;
  isLive?: boolean;
  supportsReasoning?: boolean;
  supportedReasoningEfforts?: ReasoningEffort[];
}

export function normalizeModelBaseId(modelId: string): string {
  const raw = (modelId || "").trim().toLowerCase();
  const withoutVendor = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const colonIdx = withoutVendor.indexOf(":");
  return colonIdx >= 0 ? withoutVendor.slice(0, colonIdx) : withoutVendor;
}

/**
 * Determines whether a specific model ID supports configurable reasoning effort /
 * thinking budgets across direct providers and multi-model gateways (OpenRouter,
 * Groq, Together, LiteLLM, Ollama, DashScope, etc.).
 */
export function detectReasoningCapability(
  modelId: string,
  modelInfo?: Pick<
    AttachedModelInfo,
    "supportsReasoning" | "supportedReasoningEfforts" | "name"
  >,
  baseUrl?: string
): ReasoningCapability {
  const raw = (modelId || "").trim().toLowerCase();
  if (!raw && !modelInfo?.supportsReasoning) {
    return { supported: false, efforts: [], mode: "none" };
  }

  const base = normalizeModelBaseId(raw);
  const fullText = `${raw} ${(modelInfo?.name || "").toLowerCase()}`;
  const isOpenRouter = (baseUrl || "").toLowerCase().includes("openrouter.ai");

  // 1. Explicit OpenAI reasoning families (o1, o3, o4, gpt-5)
  if (
    /^o[134]($|-)/.test(base) ||
    base.startsWith("gpt-5")
  ) {
    return {
      supported: true,
      efforts: modelInfo?.supportedReasoningEfforts?.length
        ? modelInfo.supportedReasoningEfforts
        : isOpenRouter || base.startsWith("gpt-5") || base.includes("pro")
        ? ["low", "medium", "high", "max"]
        : ["low", "medium", "high"],
      mode: "effort",
    };
  }

  // 2. Anthropic Extended Thinking (Claude 3.7 Sonnet, Claude 4 / 4.x family)
  if (
    base.includes("claude-3-7") ||
    base.includes("claude-3.7") ||
    base.includes("claude-sonnet-4") ||
    base.includes("claude-opus-4") ||
    base.includes("claude-haiku-4") ||
    base.includes("claude-4")
  ) {
    return {
      supported: true,
      efforts: ["low", "medium", "high", "max"],
      mode: isOpenRouter ? "effort" : "anthropic_thinking",
    };
  }

  // 3. Google Gemini Thinking models (2.0 Flash Thinking, 2.5+, 3.x)
  if (
    base.includes("gemini-2.5") ||
    base.includes("gemini-3") ||
    base.includes("flash-thinking")
  ) {
    return {
      supported: true,
      efforts: ["low", "medium", "high", "max"],
      mode: isOpenRouter ? "effort" : "gemini_thinking",
    };
  }

  // 4. Qwen / DashScope thinking models (Qwen3, QwQ, QVQ)
  if (
    base.startsWith("qwq") ||
    base.startsWith("qvq") ||
    base.startsWith("qwen3")
  ) {
    return {
      supported: true,
      efforts: ["low", "medium", "high", "max"],
      mode: isOpenRouter ? "effort" : "qwen_thinking",
    };
  }

  // 5. DeepSeek R1 / Reasoner, xAI Grok-3-mini / Grok-4, Magistral, Phi-4 Reasoning, explicit ":thinking"
  if (
    base.includes("deepseek-r1") ||
    base.includes("deepseek-reasoner") ||
    base.includes("grok-3-mini") ||
    base.includes("grok-4") ||
    base.includes("magistral") ||
    base.includes("phi-4-reasoning") ||
    raw.includes(":thinking") ||
    /(^|[-_/:.\s])(thinking|reasoner|reasoning)($|[-_/:.\s0-9])/.test(fullText)
  ) {
    return {
      supported: true,
      efforts: modelInfo?.supportedReasoningEfforts?.length
        ? modelInfo.supportedReasoningEfforts
        : ["low", "medium", "high", "max"],
      mode: "effort",
    };
  }

  // 6. Metadata discovered from gateway catalog (e.g. OpenRouter supported_parameters or Gemini thinking flag)
  if (modelInfo?.supportsReasoning) {
    return {
      supported: true,
      efforts: modelInfo.supportedReasoningEfforts?.length
        ? modelInfo.supportedReasoningEfforts
        : ["low", "medium", "high", "max"],
      mode: "effort",
    };
  }

  return { supported: false, efforts: [], mode: "none" };
}

export function getActiveModelReasoningCapability(
  settings: AISidepanelSettings
): ReasoningCapability {
  const attached = getSyncedAttachedModels(settings);
  const match = attached.find((m) => m.id === settings.model);
  return detectReasoningCapability(settings.model || "", match, settings.baseUrl);
}

export function categorizeModel(
  id: string,
  name = "",
  description = ""
): ModelCategory {
  const text = `${id} ${name}`.toLowerCase();
  const full = `${text} ${description}`.toLowerCase();

  // 1. Coding Specialists (checked before flagship/fast so qwen3-coder-plus stays in coding)
  if (
    /(^|[-_/:.\s])(coder|codex|codestral|devstral|starcoder)([-_/:.\s]|$)/.test(text) ||
    text.includes("coder") ||
    text.includes("codex") ||
    /(^|[-_/:.\s])(kimi|glm)([-_/:.\s0-9]|$)/.test(text) ||
    full.includes("coding plan") ||
    full.includes("coding specialist") ||
    full.includes("coding agent")
  ) {
    return "coding";
  }

  // 2. Vision & Multimodal
  if (
    /(^|[-_/:.\s])vl($|[-_/:.\s0-9])/.test(text) ||
    /(^|[-_/:.\s])(vision|pixtral|qvq|llava)([-_/:.\s0-9]|$)/.test(text)
  ) {
    return "vision";
  }

  // 3. Fast & Lightweight (delimiter-safe so "gemini" / "minimax" don't match "mini")
  if (
    /(^|[-_/:.\s])(flash|turbo|mini|nano|haiku|lite|instant|fast)($|[-_/:.\s0-9])/.test(
      text
    ) ||
    /(^|[-_/:.\s])(1\.5b|3b|4b|7b|8b|9b|14b)($|[-_/:.\s])/.test(text)
  ) {
    return "fast";
  }

  // 4. Flagship & Reasoning
  if (
    /(^|[-_/:.\s])(max|opus|sonnet|qwq|reasoner|thinking|ultra|large|pro|plus|o1|o3|o4|r1|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5)($|[-_/:.\s0-9])/.test(
      text
    ) ||
    text.includes("deepseek-chat") ||
    text.includes("deepseek-v3") ||
    text.includes("minimax-m")
  ) {
    return "flagship";
  }

  return "other";
}

export function getSyncedAttachedModels(
  settings: AISidepanelSettings
): Array<AttachedModelInfo & { isLive: boolean; category: ModelCategory }> {
  const sameKey = (settings.lastIdentifiedKey || "") === (settings.apiKey || "");
  const sameUrl = (settings.lastIdentifiedBaseUrl || "") === (settings.baseUrl || "");
  if (!sameKey || !sameUrl) return [];
  return (settings.attachedModels || [])
    .filter((m) => m.isLive === true)
    .map((m) => ({
      ...m,
      isLive: true,
      category: m.category || categorizeModel(m.id, m.name, m.description),
    }));
}

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  provider?: AIProvider;
  model?: string;
  attachedModels?: AttachedModelInfo[];
  lastIdentifiedKey?: string;
  lastIdentifiedBaseUrl?: string;
  lastIdentifiedProvider?: string;
}

export interface AISidepanelSettings {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  enableVaultTools: boolean;
  autoIncludeActiveNote: boolean;
  confirmBeforeNoteChanges: boolean;
  maxToolIterations: number;
  autoContinueTasks?: boolean;
  profiles?: ProviderProfile[];
  activeProfileId?: string;
  attachedModels?: AttachedModelInfo[];
  lastIdentifiedKey?: string;
  lastIdentifiedBaseUrl?: string;
  lastIdentifiedProvider?: string;
  modelScanVersion?: number;
}

export function inferProtocolFromBaseUrl(baseUrl: string): AIProvider {
  const lower = (baseUrl || "").trim().toLowerCase();
  if (lower.includes("generativelanguage.googleapis.com")) {
    return "gemini";
  }
  if (
    lower.includes("api.anthropic.com") ||
    lower.endsWith("/anthropic") ||
    lower.includes("/apps/anthropic")
  ) {
    return "anthropic";
  }
  return "openai-compatible";
}

export function getProviderLabelFromBaseUrl(baseUrl: string): string {
  const clean = (baseUrl || "").trim();
  if (!clean) return "No Endpoint";
  const lower = clean.toLowerCase();
  if (lower.includes("dashscope") || lower.includes("qwen")) return "Qwen Cloud";
  if (lower.includes("generativelanguage.googleapis.com")) return "Google Gemini";
  if (lower.includes("anthropic")) return "Anthropic Claude";
  if (lower.includes("openrouter.ai")) return "OpenRouter";
  if (lower.includes("api.openai.com")) return "OpenAI";
  if (lower.includes("api.groq.com")) return "Groq";
  if (lower.includes("api.deepseek.com")) return "DeepSeek";
  if (lower.includes("localhost") || lower.includes("127.0.0.1")) return "Local Endpoint";
  try {
    return new URL(clean).hostname;
  } catch {
    return "Custom API";
  }
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  const lower = (baseUrl || "").toLowerCase();
  return lower.includes("localhost") || lower.includes("127.0.0.1");
}

export const DEFAULT_SETTINGS: AISidepanelSettings = {
  provider: "openai-compatible",
  apiKey: "",
  baseUrl: "",
  model: "",
  reasoningEffort: "medium",
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: `You are an intelligent AI assistant embedded directly inside Obsidian.
You have direct read, write, edit, rename/move, delete, folder management, workspace control, and Graph View access to the user's Obsidian Vault through specialized tools.

CORE ACTION MANDATE:
- When the user asks you to fix, edit, update, modify, rewrite, correct, append, patch, create, or delete anything in their notes or workspace, YOU MUST CALL THE CORRESPONDING VAULT TOOL (such as patch_note, replace_note_content, edit_active_editor, append_to_note, or create_note) to execute the change.
- NEVER merely describe, summarize, or claim in conversational text that you have made, fixed, or applied changes without having executed the actual tool call in that turn. Saying "I have fixed the issue" without invoking a tool does NOT change the user's note in Obsidian.
- For surgical line edits or typo fixes in an existing note, prefer patch_note or edit_active_editor. For major note rewrites, use replace_note_content.
- Always execute the tool FIRST so the change is applied live in the user's Obsidian workspace, and only then provide your final confirmation and explanation.
- If the user refers to "this note", "the note", or "active note", use the active note path provided in the context.
- When inspecting or editing multiple notes, batch parallel tool calls in a single step where possible to save steps.
- Respect the user's note-taking structure, ask before massive destructive deletions, and note that all changes can be selectively reverted by the user via chat Undo.

FORMATTING & STYLE:
- Write in clean, natural prose. Avoid em-dashes (—), en-dashes (–), and spaced hyphens ( - ) between clauses; use commas, periods, colons, or parentheses instead.
- Keep Markdown tables compact (2–4 short columns with concise cell values) so they fit cleanly in a narrow sidepanel; prefer structured bullet lists for longer multi-sentence comparisons.`,
  enableVaultTools: true,
  autoIncludeActiveNote: true,
  confirmBeforeNoteChanges: false,
  maxToolIterations: 25,
  autoContinueTasks: true,
  profiles: [],
  activeProfileId: "",
  attachedModels: [],
  modelScanVersion: 3,
};

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface DeletedVaultItemSnapshot {
  path: string;
  isFolder: boolean;
  content?: string | null;
  binaryBase64?: string;
}

export interface NoteChangeRecord {
  id?: string;
  itemKind?: "note" | "folder";
  path: string;
  previousPath?: string;
  type: "created" | "modified" | "deleted" | "renamed";
  previousContent: string | null;
  newContent?: string | null;
  previousBinaryBase64?: string;
  folderSnapshot?: DeletedVaultItemSnapshot[];
  redoContent?: string | null;
  redoBinaryBase64?: string;
  redoFolderSnapshot?: DeletedVaultItemSnapshot[];
  reverted?: boolean;
  timestamp: number;
}

export interface ToolActivityRecord {
  id: string;
  name: string;
  label: string;
  argsPreview?: string;
  resultPreview?: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  durationMs?: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  timestamp?: number;
  statusInfo?: string;
  noteChanges?: NoteChangeRecord[];
  changesReverted?: boolean;
  hitToolLimit?: boolean;
  canResumeTask?: boolean;
  toolActivities?: ToolActivityRecord[];
  reasoningContent?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface VaultToolParamProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface VaultToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, VaultToolParamProperty>;
    required?: string[];
  };
}

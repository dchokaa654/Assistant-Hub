import { requestUrl } from "obsidian";
import {
  AIProvider,
  AISidepanelSettings,
  AttachedModelInfo,
  categorizeModel,
  detectReasoningCapability,
  getProviderLabelFromBaseUrl,
  inferProtocolFromBaseUrl,
  isLocalBaseUrl,
  MODEL_CATEGORY_ORDER,
  ModelCategory,
} from "../types";

export interface AvailableModelItem extends AttachedModelInfo {
  id: string;
  name: string;
  description?: string;
  category?: ModelCategory;
  isLive: boolean;
}

export interface ScanProgress {
  phase: "authenticating" | "verifying" | "done" | "error";
  message: string;
  provider?: AIProvider;
  providerTitle?: string;
  checked: number;
  total: number;
  verifiedModels: AvailableModelItem[];
}

export interface KeyIdentificationResult {
  success: boolean;
  provider: AIProvider;
  providerTitle: string;
  baseUrl: string;
  isLiveApi: boolean;
  models: AvailableModelItem[];
  rejectedCount: number;
  error?: string;
}

const NON_CHAT_PATTERNS = [
  "embedding",
  "embed",
  "text-similarity",
  "text-search",
  "code-search",
  "whisper",
  "tts",
  "dall-e",
  "imagen",
  "veo-",
  "wanx",
  "sambert",
  "paraformer",
  "cosyvoice",
  "sensevoice",
  "qwen-audio",
  "qwen2-audio",
  "omni-audio",
  "realtime",
  "audio-preview",
  "transcribe",
  "moderation",
  "rerank",
  "gte-rerank",
  "babbage",
  "davinci",
  "curie",
  "ada-",
  "aqa",
  "-ocr",
  "speech",
  "image-generation",
];

function isLikelyChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_PATTERNS.some((p) => lower.includes(p));
}

function hasDateSuffix(id: string): boolean {
  // Matches suffixes like -2024-08-06, -20241022, -0919, -001, -002
  return /(-\d{4}-\d{2}-\d{2}|-\d{8}|-\d{4}|-\d{3})$/.test(id);
}

function stripDateSuffix(id: string): string {
  return id.replace(/(-\d{4}-\d{2}-\d{2}|-\d{8}|-\d{4}|-\d{3})$/, "");
}

function sortVerifiedModels(models: AvailableModelItem[]): AvailableModelItem[] {
  const rankOf = (cat?: ModelCategory): number => {
    const idx = MODEL_CATEGORY_ORDER.indexOf(cat || "other");
    return idx === -1 ? 99 : idx;
  };
  return [...models].sort((a, b) => {
    const catDiff =
      rankOf(a.category || categorizeModel(a.id, a.name, a.description)) -
      rankOf(b.category || categorizeModel(b.id, b.name, b.description));
    if (catDiff !== 0) return catDiff;
    const datedDiff = (hasDateSuffix(a.id) ? 1 : 0) - (hasDateSuffix(b.id) ? 1 : 0);
    if (datedDiff !== 0) return datedDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Deduplicates, categorizes, and balances candidates across model families so
 * dated snapshots or a single noisy family never crowd out other attached models.
 */
function prioritizeMultiModelCandidates(
  rawCandidates: AvailableModelItem[],
  preferredModelId?: string,
  maxCount = 44
): AvailableModelItem[] {
  const dedupedMap = new Map<string, AvailableModelItem>();
  for (const c of rawCandidates) {
    const id = (c.id || "").trim();
    if (!id) continue;
    const category = c.category || categorizeModel(id, c.name, c.description);
    const existing = dedupedMap.get(id);
    if (!existing || (!existing.description && c.description)) {
      dedupedMap.set(id, { ...c, id, category });
    }
  }

  const all = Array.from(dedupedMap.values());
  if (all.length === 0) return [];

  const canonicalLowerIds = new Set(
    all.filter((c) => !hasDateSuffix(c.id)).map((c) => c.id.toLowerCase())
  );

  const selected: AvailableModelItem[] = [];
  const usedIds = new Set<string>();
  const addItem = (item: AvailableModelItem) => {
    if (!usedIds.has(item.id) && selected.length < maxCount) {
      usedIds.add(item.id);
      selected.push(item);
    }
  };

  // 1. Always verify the user's currently configured model first if present
  const cleanPref = (preferredModelId || "").trim();
  if (cleanPref) {
    const prefMatch = all.find((c) => c.id === cleanPref);
    if (prefMatch) addItem(prefMatch);
  }

  // 2. Round-robin canonical models across categories so every capability tier is tested
  const canonicalBuckets = new Map<ModelCategory, AvailableModelItem[]>();
  for (const cat of MODEL_CATEGORY_ORDER) canonicalBuckets.set(cat, []);

  const uniqueDated: AvailableModelItem[] = [];
  const redundantSnapshots: AvailableModelItem[] = [];

  for (const item of all) {
    if (usedIds.has(item.id)) continue;
    if (!hasDateSuffix(item.id)) {
      const bucket = canonicalBuckets.get(item.category || "other")!;
      bucket.push(item);
    } else {
      const baseLower = stripDateSuffix(item.id).toLowerCase();
      if (canonicalLowerIds.has(baseLower)) {
        redundantSnapshots.push(item);
      } else {
        uniqueDated.push(item);
      }
    }
  }

  for (const bucket of canonicalBuckets.values()) {
    bucket.sort((a, b) => a.id.localeCompare(b.id));
  }

  let progressed = true;
  while (selected.length < maxCount && progressed) {
    progressed = false;
    for (const cat of MODEL_CATEGORY_ORDER) {
      const bucket = canonicalBuckets.get(cat)!;
      if (bucket.length > 0 && selected.length < maxCount) {
        addItem(bucket.shift()!);
        progressed = true;
      }
    }
  }

  // 3. Fill remaining capacity with dated-only models, then redundant snapshots
  uniqueDated.sort((a, b) => a.id.localeCompare(b.id));
  for (const item of uniqueDated) {
    if (selected.length >= maxCount) break;
    addItem(item);
  }
  redundantSnapshots.sort((a, b) => a.id.localeCompare(b.id));
  for (const item of redundantSnapshots) {
    if (selected.length >= maxCount) break;
    addItem(item);
  }

  return selected;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractApiErrorReason(status: number, json: any, text: string): string {
  const msg =
    json?.error?.message ||
    json?.message ||
    json?.error?.code ||
    (typeof text === "string" ? text.slice(0, 140) : "");
  return `${status}${msg ? `: ${msg}` : ""}`;
}

function isAuthenticationErrorText(text: string): boolean {
  const lowerErr = (text || "").toLowerCase();
  return (
    lowerErr.includes("invalid_api_key") ||
    lowerErr.includes("invalid api-key") ||
    lowerErr.includes("invalid api key") ||
    lowerErr.includes("incorrect api key") ||
    lowerErr.includes("authentication") ||
    lowerErr.includes("unauthorized")
  );
}

interface ProbeModelResult {
  ok: boolean;
  fatalAuth?: boolean;
  reason?: string;
}

/**
 * Verifies a single OpenAI-compatible model can actually be invoked by this key
 */
async function verifyOpenAICompatibleModel(
  baseUrl: string,
  key: string,
  modelId: string,
  attempt = 0
): Promise<ProbeModelResult> {
  const cleanBase = baseUrl.replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
  const endpoint = `${cleanBase}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  if (cleanBase.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://obsidian.md";
    headers["X-Title"] = "Obsidian AI Sidepanel";
  }

  const buildBody = (useMaxCompletionTokens = false, tokens = 1) => {
    const payload: any = {
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    };
    if (useMaxCompletionTokens) {
      payload.max_completion_tokens = Math.max(16, tokens);
    } else {
      payload.max_tokens = tokens;
    }
    if (
      cleanBase.includes("dashscope") ||
      modelId.toLowerCase().includes("qwen3") ||
      modelId.toLowerCase().includes("qwq")
    ) {
      payload.enable_thinking = false;
    }
    return JSON.stringify(payload);
  };

  try {
    const res = await requestUrl({
      url: endpoint,
      method: "POST",
      headers,
      body: buildBody(false, 1),
      throw: false,
    });

    if (res.status === 200) {
      let json: any = null;
      try {
        json = res.json;
      } catch {}
      if (json?.error) {
        return {
          ok: false,
          reason: extractApiErrorReason(200, json, res.text),
        };
      }
      if (json && (Array.isArray(json.choices) || json.id)) {
        return { ok: true };
      }
      return { ok: false, reason: "Unexpected non-chat response format" };
    }

    if (res.status === 401) {
      return {
        ok: false,
        fatalAuth: true,
        reason: extractApiErrorReason(401, res.json, res.text),
      };
    }

    if (res.status === 400 && attempt === 0) {
      const lowerText = (res.text || "").toLowerCase();
      if (lowerText.includes("max_completion_tokens")) {
        const retryRes = await requestUrl({
          url: endpoint,
          method: "POST",
          headers,
          body: buildBody(true, 16),
          throw: false,
        });
        if (retryRes.status === 200 && !retryRes.json?.error) {
          return { ok: true };
        }
        return {
          ok: false,
          reason: extractApiErrorReason(retryRes.status, retryRes.json, retryRes.text),
        };
      }
      if (
        lowerText.includes("max_tokens") ||
        lowerText.includes("at least") ||
        lowerText.includes("enable_thinking")
      ) {
        const retryRes = await requestUrl({
          url: endpoint,
          method: "POST",
          headers,
          body: buildBody(false, 16),
          throw: false,
        });
        if (retryRes.status === 200 && !retryRes.json?.error) {
          return { ok: true };
        }
        return {
          ok: false,
          reason: extractApiErrorReason(retryRes.status, retryRes.json, retryRes.text),
        };
      }
    }

    if (res.status === 429) {
      const lowerText = (res.text || "").toLowerCase();
      const isNoQuota =
        lowerText.includes("quota") ||
        lowerText.includes("limit: 0") ||
        lowerText.includes("insufficient") ||
        lowerText.includes("billing") ||
        lowerText.includes("balance") ||
        lowerText.includes("arrearage") ||
        lowerText.includes("free tier");
      if (!isNoQuota && attempt === 0) {
        await sleep(850);
        return await verifyOpenAICompatibleModel(baseUrl, key, modelId, 1);
      }
      return {
        ok: false,
        reason: extractApiErrorReason(429, res.json, res.text),
      };
    }

    return {
      ok: false,
      fatalAuth: isAuthenticationErrorText(res.text),
      reason: extractApiErrorReason(res.status, res.json, res.text),
    };
  } catch (err: any) {
    return { ok: false, reason: err?.message || "Network error" };
  }
}

function normalizeGeminiRoot(baseUrl: string): string {
  return (baseUrl || "https://generativelanguage.googleapis.com")
    .trim()
    .replace(/\/v1beta(\/models)?$/, "")
    .replace(/\/+$/, "");
}

function normalizeAnthropicRoot(baseUrl: string): string {
  return (baseUrl || "https://api.anthropic.com")
    .trim()
    .replace(/\/v1\/messages$/, "")
    .replace(/\/v1$/, "")
    .replace(/\/+$/, "");
}

/**
 * Verifies a single Google Gemini model via generateContent
 */
async function verifyGeminiModel(
  baseUrl: string,
  key: string,
  modelId: string,
  attempt = 0
): Promise<ProbeModelResult> {
  const root = normalizeGeminiRoot(baseUrl);
  const url = `${root}/v1beta/models/${encodeURIComponent(
    modelId
  )}:generateContent?key=${encodeURIComponent(key)}`;

  try {
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
      throw: false,
    });

    if (res.status === 200 && (res.json?.candidates || res.json?.usageMetadata)) {
      return { ok: true };
    }

    if (res.status === 401 || (res.status === 400 && (res.text || "").includes("API_KEY_INVALID"))) {
      return {
        ok: false,
        fatalAuth: true,
        reason: extractApiErrorReason(res.status, res.json, res.text),
      };
    }

    if (res.status === 429) {
      const lowerText = (res.text || "").toLowerCase();
      const isZeroQuota =
        lowerText.includes("limit: 0") ||
        lowerText.includes("quota_limit_value\":\"0") ||
        lowerText.includes("free_tier") && lowerText.includes("limit: 0");
      if (!isZeroQuota && attempt === 0) {
        await sleep(1000);
        return await verifyGeminiModel(baseUrl, key, modelId, 1);
      }
      return {
        ok: false,
        reason: extractApiErrorReason(429, res.json, res.text),
      };
    }

    return {
      ok: false,
      fatalAuth: isAuthenticationErrorText(res.text),
      reason: extractApiErrorReason(res.status, res.json, res.text),
    };
  } catch (err: any) {
    return { ok: false, reason: err?.message || "Network error" };
  }
}

/**
 * Verifies a single Anthropic Claude model via /v1/messages
 */
async function verifyAnthropicModel(
  baseUrl: string,
  key: string,
  modelId: string,
  attempt = 0
): Promise<ProbeModelResult> {
  const root = normalizeAnthropicRoot(baseUrl);
  try {
    const res = await requestUrl({
      url: `${root}/v1/messages`,
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      throw: false,
    });

    if (res.status === 200 && (res.json?.content || res.json?.id)) {
      return { ok: true };
    }
    if (res.status === 401) {
      return {
        ok: false,
        fatalAuth: true,
        reason: extractApiErrorReason(401, res.json, res.text),
      };
    }
    if (res.status === 429 && attempt === 0) {
      await sleep(800);
      return await verifyAnthropicModel(baseUrl, key, modelId, 1);
    }
    return {
      ok: false,
      fatalAuth: isAuthenticationErrorText(res.text),
      reason: extractApiErrorReason(res.status, res.json, res.text),
    };
  } catch (err: any) {
    return { ok: false, reason: err?.message || "Network error" };
  }
}

/**
 * Runs candidate verification with bounded concurrency and real-time progress updates
 */
async function verifyCandidatesInPool(
  candidates: AvailableModelItem[],
  verifyFn: (modelId: string) => Promise<ProbeModelResult>,
  onProgress?: (verified: AvailableModelItem[], checked: number, total: number) => void,
  signal?: AbortSignal,
  concurrency = 4
): Promise<{
  verified: AvailableModelItem[];
  rejectedCount: number;
  lastError: string;
  fatalAuth: boolean;
}> {
  const verified: AvailableModelItem[] = [];
  let checked = 0;
  let rejectedCount = 0;
  let lastError = "";
  let fatalAuth = false;
  let index = 0;

  async function worker(): Promise<void> {
    while (index < candidates.length) {
      if (signal?.aborted || fatalAuth) return;
      const myIdx = index++;
      const item = candidates[myIdx];

      const res = await verifyFn(item.id);
      checked++;

      if (res.fatalAuth) {
        fatalAuth = true;
        lastError = res.reason || "Authentication failed";
        return;
      }

      if (res.ok) {
        verified.push({
          ...item,
          category:
            item.category ||
            categorizeModel(item.id, item.name, item.description),
          isLive: true,
        });
      } else {
        rejectedCount++;
        if (res.reason) lastError = res.reason;
      }

      onProgress?.(sortVerifiedModels(verified), checked, candidates.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker());
  await Promise.all(workers);

  return {
    verified: sortVerifiedModels(verified),
    rejectedCount,
    lastError,
    fatalAuth,
  };
}

/**
 * Build candidate list and verify models for Google Gemini
 */
async function scanGemini(
  baseUrl: string,
  key: string,
  preferredModel?: string,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<KeyIdentificationResult | null> {
  const root = normalizeGeminiRoot(baseUrl);
  const url = `${root}/v1beta/models?key=${encodeURIComponent(key)}`;
  try {
    const res = await requestUrl({ url, method: "GET", throw: false });
    if (res.status !== 200 || !Array.isArray(res.json?.models)) {
      return null;
    }

    const candidates: AvailableModelItem[] = [];
    for (const m of res.json.models) {
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes("generateContent")) continue;
      const cleanId = (m.name || "").replace(/^models\//, "");
      if (!isLikelyChatModel(cleanId)) continue;
      const displayName = m.displayName || cleanId;
      const desc =
        m.description ||
        `Input limit: ${m.inputTokenLimit?.toLocaleString() || "1M"} tokens`;
      const reasoningCap = detectReasoningCapability(
        cleanId,
        { name: displayName, supportsReasoning: m.thinking === true },
        root
      );
      candidates.push({
        id: cleanId,
        name: displayName,
        description: desc,
        category: categorizeModel(cleanId, displayName, desc),
        supportsReasoning: reasoningCap.supported,
        supportedReasoningEfforts: reasoningCap.efforts,
        isLive: false,
      });
    }

    // Prioritize canonical 2.5+ and balanced Gemini models first before snapshots
    candidates.sort((a, b) => {
      const aNew = a.id.includes("2.5") || a.id.includes("3") ? 0 : 1;
      const bNew = b.id.includes("2.5") || b.id.includes("3") ? 0 : 1;
      if (aNew !== bNew) return aNew - bNew;
      return a.id.localeCompare(b.id);
    });
    const toVerify = prioritizeMultiModelCandidates(candidates, preferredModel, 32);

    onProgress?.({
      phase: "verifying",
      message: `Testing access permissions on ${toVerify.length} Gemini models...`,
      provider: "gemini",
      providerTitle: "Google Gemini",
      checked: 0,
      total: toVerify.length,
      verifiedModels: [],
    });

    const poolResult = await verifyCandidatesInPool(
      toVerify,
      (id) => verifyGeminiModel(root, key, id),
      (verifiedSoFar, checked, total) => {
        onProgress?.({
          phase: "verifying",
          message: `Verifying Gemini access (${checked}/${total} tested — ${verifiedSoFar.length} callable)...`,
          provider: "gemini",
          providerTitle: "Google Gemini",
          checked,
          total,
          verifiedModels: verifiedSoFar,
        });
      },
      signal,
      3
    );

    if (poolResult.fatalAuth) return null;

    return {
      success: poolResult.verified.length > 0,
      provider: "gemini",
      providerTitle: "Google Gemini",
      baseUrl: root,
      isLiveApi: poolResult.verified.length > 0,
      models: poolResult.verified,
      rejectedCount: poolResult.rejectedCount,
      error:
        poolResult.verified.length === 0
          ? `Key recognized by Gemini, but 0 models permitted generation (${poolResult.lastError}).`
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Scan & verify models for Anthropic Claude
 */
async function scanAnthropic(
  baseUrl: string,
  key: string,
  preferredModel?: string,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<KeyIdentificationResult | null> {
  const root = normalizeAnthropicRoot(baseUrl);
  try {
    const res = await requestUrl({
      url: `${root}/v1/models`,
      method: "GET",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      throw: false,
    });
    if (res.status !== 200 || !Array.isArray(res.json?.data)) {
      return null;
    }

    const rawCandidates: AvailableModelItem[] = res.json.data.map((m: any) => {
      const name = m.display_name || m.id;
      const desc = `Anthropic Claude (${
        m.created_at ? new Date(m.created_at).toLocaleDateString() : "Active"
      })`;
      const reasoningCap = detectReasoningCapability(m.id, { name }, root);
      return {
        id: m.id,
        name,
        description: desc,
        category: categorizeModel(m.id, name, desc),
        supportsReasoning: reasoningCap.supported,
        supportedReasoningEfforts: reasoningCap.efforts,
        isLive: false,
      };
    });
    const candidates = prioritizeMultiModelCandidates(rawCandidates, preferredModel, 32);

    onProgress?.({
      phase: "verifying",
      message: `Verifying ${candidates.length} Anthropic models with API key...`,
      provider: "anthropic",
      providerTitle: "Anthropic Claude",
      checked: 0,
      total: candidates.length,
      verifiedModels: [],
    });

    const poolResult = await verifyCandidatesInPool(
      candidates,
      (id) => verifyAnthropicModel(root, key, id),
      (verifiedSoFar, checked, total) => {
        onProgress?.({
          phase: "verifying",
          message: `Verifying Anthropic access (${checked}/${total} tested — ${verifiedSoFar.length} callable)...`,
          provider: "anthropic",
          providerTitle: "Anthropic Claude",
          checked,
          total,
          verifiedModels: verifiedSoFar,
        });
      },
      signal,
      4
    );

    if (poolResult.fatalAuth) return null;

    return {
      success: poolResult.verified.length > 0,
      provider: "anthropic",
      providerTitle: "Anthropic Claude",
      baseUrl: root,
      isLiveApi: poolResult.verified.length > 0,
      models: poolResult.verified,
      rejectedCount: poolResult.rejectedCount,
      error:
        poolResult.verified.length === 0
          ? `Authenticated with Anthropic, but 0 models succeeded (${poolResult.lastError}).`
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Scan & verify OpenRouter ONLY if /auth/key strictly validates the key!
 */
async function scanOpenRouter(
  baseUrl: string,
  key: string,
  preferredModel?: string,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<KeyIdentificationResult | null> {
  const cleanBase = (baseUrl || "https://openrouter.ai/api/v1")
    .trim()
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");
  try {
    // 1. STRICT KEY AUTHENTICATION (/models is public on OpenRouter, /auth/key is NOT!)
    const authRes = await requestUrl({
      url: `${cleanBase}/auth/key`,
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      throw: false,
    });
    if (authRes.status !== 200 || !authRes.json?.data) {
      return null;
    }

    const keyData = authRes.json.data;
    let hasCredits = !keyData.is_free_tier;

    // Also query /credits to get exact credit balance
    const creditsRes = await requestUrl({
      url: `${cleanBase}/credits`,
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      throw: false,
    });
    if (creditsRes.status === 200 && creditsRes.json?.data) {
      const total = Number(creditsRes.json.data.total_credits || 0);
      const used = Number(creditsRes.json.data.total_usage || 0);
      if (total - used > 0.001) {
        hasCredits = true;
      } else if (total === 0) {
        hasCredits = false;
      }
    }
    if (
      typeof keyData.limit_remaining === "number" &&
      keyData.limit_remaining <= 0.0001
    ) {
      hasCredits = false;
    }

    // 2. Fetch catalog and filter strictly to models usable by this key tier
    const modelsRes = await requestUrl({
      url: `${cleanBase}/models`,
      method: "GET",
      throw: false,
    });
    if (modelsRes.status !== 200 || !Array.isArray(modelsRes.json?.data)) {
      return null;
    }

    const rawModels: any[] = modelsRes.json.data;
    const eligible = rawModels.filter((m) => {
      if (!m.id || !isLikelyChatModel(m.id)) return false;
      if (!hasCredits) {
        const promptCost = Number(m.pricing?.prompt ?? 1);
        const compCost = Number(m.pricing?.completion ?? 1);
        return m.id.endsWith(":free") || (promptCost === 0 && compCost === 0);
      }
      return true;
    });

    // Prioritize top/canonical models for fast verification (cap at 18 so we never blast 300+ requests)
    const priorityOrder = [
      ":free",
      "google/gemini-2.5",
      "anthropic/claude-3.5",
      "anthropic/claude-3.7",
      "openai/gpt-4o",
      "deepseek/deepseek",
      "qwen/qwen",
      "meta-llama/llama-3.3",
    ];
    eligible.sort((a, b) => {
      const aScore = priorityOrder.findIndex((p) => a.id.includes(p));
      const bScore = priorityOrder.findIndex((p) => b.id.includes(p));
      const sA = aScore === -1 ? 99 : aScore;
      const sB = bScore === -1 ? 99 : bScore;
      return sA - sB;
    });

    const rawEligibleItems: AvailableModelItem[] = eligible.slice(0, 24).map((m) => {
      const name = m.name || m.id;
      const desc = m.context_length
        ? `Context: ${m.context_length.toLocaleString()} tokens${
            !hasCredits ? " (Free Tier)" : ""
          }`
        : undefined;
      const params: string[] = Array.isArray(m.supported_parameters)
        ? m.supported_parameters
        : [];
      const hasReasoningParam =
        params.includes("reasoning") ||
        params.includes("reasoning_effort") ||
        params.includes("include_reasoning");
      const reasoningCap = detectReasoningCapability(
        m.id,
        { name, supportsReasoning: hasReasoningParam },
        cleanBase
      );
      return {
        id: m.id,
        name,
        description: desc,
        category: categorizeModel(m.id, name, desc || ""),
        supportsReasoning: reasoningCap.supported,
        supportedReasoningEfforts: reasoningCap.efforts,
        isLive: false,
      };
    });
    const toVerify = prioritizeMultiModelCandidates(rawEligibleItems, preferredModel, 24);

    if (toVerify.length === 0) {
      return {
        success: false,
        provider: "openai-compatible",
        providerTitle: "OpenRouter",
        baseUrl: cleanBase,
        isLiveApi: false,
        models: [],
        rejectedCount: 0,
        error: "OpenRouter key verified, but no eligible models found for this credit tier.",
      };
    }

    onProgress?.({
      phase: "verifying",
      message: `Verifying OpenRouter models (${hasCredits ? "Funded Key" : "Free Tier Only"})...`,
      provider: "openai-compatible",
      providerTitle: "OpenRouter",
      checked: 0,
      total: toVerify.length,
      verifiedModels: [],
    });

    const poolResult = await verifyCandidatesInPool(
      toVerify,
      (id) => verifyOpenAICompatibleModel(cleanBase, key, id),
      (verifiedSoFar, checked, total) => {
        onProgress?.({
          phase: "verifying",
          message: `Verifying OpenRouter models (${checked}/${total} tested — ${verifiedSoFar.length} callable)...`,
          provider: "openai-compatible",
          providerTitle: "OpenRouter",
          checked,
          total,
          verifiedModels: verifiedSoFar,
        });
      },
      signal,
      4
    );

    return {
      success: poolResult.verified.length > 0,
      provider: "openai-compatible",
      providerTitle: hasCredits ? "OpenRouter" : "OpenRouter (Free Tier)",
      baseUrl: cleanBase,
      isLiveApi: poolResult.verified.length > 0,
      models: poolResult.verified,
      rejectedCount: poolResult.rejectedCount,
      error:
        poolResult.verified.length === 0
          ? `OpenRouter key authenticated, but all tested models failed (${poolResult.lastError}).`
          : undefined,
    };
  } catch {
    return null;
  }
}

const QWEN_CODING_PLAN_CANDIDATES: AvailableModelItem[] = [
  { id: "qwen3.5-plus", name: "Qwen 3.5 Plus", description: "Coding Plan flagship reasoning & code model", isLive: false },
  { id: "qwen3.5-flash", name: "Qwen 3.5 Flash", description: "Fast Qwen 3.5 coding model", isLive: false },
  { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", description: "Latest Qwen 3.6 Plus model", isLive: false },
  { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", description: "Latest Qwen 3.7 Plus model", isLive: false },
  { id: "qwen3.8-max", name: "Qwen 3.8 Max", description: "Flagship Qwen 3.8 Max model", isLive: false },
  { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", description: "Ultra-fast Qwen 3.8 Flash model", isLive: false },
  { id: "qwen3-max", name: "Qwen 3 Max", description: "Qwen 3 flagship model", isLive: false },
  { id: "qwen3-max-2026-01-23", name: "Qwen 3 Max (2026-01-23)", description: "Qwen 3 Max Coding Plan release", isLive: false },
  { id: "qwen3-coder-next", name: "Qwen 3 Coder Next", description: "Next-gen Qwen 3 coding agent", isLive: false },
  { id: "qwen3-coder-plus", name: "Qwen 3 Coder Plus", description: "Qwen 3 coding specialist", isLive: false },
  { id: "qwen-max", name: "Qwen Max", description: "Flagship Qwen model", isLive: false },
  { id: "qwen-plus", name: "Qwen Plus", description: "Balanced intelligence & speed", isLive: false },
  { id: "qwen-turbo", name: "Qwen Turbo", description: "Ultra-fast economical Qwen model", isLive: false },
  { id: "qwen-coder-plus", name: "Qwen Coder Plus", description: "Dedicated coding model", isLive: false },
  { id: "glm-5", name: "GLM-5", description: "Zhipu GLM-5 Coding Plan model", isLive: false },
  { id: "glm-4.7", name: "GLM-4.7", description: "Zhipu GLM-4.7 model", isLive: false },
  { id: "kimi-k2.5", name: "Kimi K2.5", description: "Moonshot Kimi K2.5 coding model", isLive: false },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", description: "MiniMax M2.5 model", isLive: false },
];

/**
 * Scan & verify OpenAI-compatible endpoints via the user's configured Base URL & API Key
 */
async function scanOpenAICompatibleEndpoint(
  key: string,
  baseUrl: string,
  providerTitle: string,
  preferredModel?: string,
  fallbackCandidates: AvailableModelItem[] = [],
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<KeyIdentificationResult | null> {
  const cleanBase = baseUrl.replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
  const modelsUrl = `${cleanBase}/models`;

  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;

  let candidates: AvailableModelItem[] = [];
  let endpointAlive = false;

  try {
    const res = await requestUrl({ url: modelsUrl, method: "GET", headers, throw: false });
    if (res.status === 401) {
      return null; // Strictly wrong key for this endpoint
    }
    if (res.status === 200) {
      endpointAlive = true;
      const data = res.json?.data || res.json?.models;
      if (Array.isArray(data) && data.length > 0) {
        candidates = data
          .filter((m: any) => {
            const id = m.id || m.name || "";
            return id && isLikelyChatModel(id);
          })
          .map((m: any) => {
            const id = m.id || m.name;
            const name = m.name || m.id;
            const desc =
              m.description ||
              (m.context_length
                ? `Context: ${m.context_length.toLocaleString()} tokens`
                : undefined);
            const params: string[] = Array.isArray(m.supported_parameters)
              ? m.supported_parameters
              : [];
            const hasReasoningParam =
              params.includes("reasoning") || params.includes("reasoning_effort");
            const reasoningCap = detectReasoningCapability(
              id,
              { name, supportsReasoning: hasReasoningParam },
              cleanBase
            );
            return {
              id,
              name,
              description: desc,
              category: categorizeModel(id, name, desc || ""),
              supportsReasoning: reasoningCap.supported,
              supportedReasoningEfforts: reasoningCap.efforts,
              isLive: false,
            };
          });
      }
    }
  } catch {
    return null;
  }

  // Ollama native catalog fallback (/api/tags) when targeting local endpoints without standard /models results
  if (isLocalBaseUrl(cleanBase) && candidates.length === 0) {
    try {
      const ollamaRoot = cleanBase.replace(/\/v1$/, "");
      const tagsRes = await requestUrl({
        url: `${ollamaRoot}/api/tags`,
        method: "GET",
        throw: false,
      });
      if (tagsRes.status === 200 && Array.isArray(tagsRes.json?.models)) {
        endpointAlive = true;
        candidates = tagsRes.json.models
          .filter((m: any) => (m.name || m.model) && isLikelyChatModel(m.name || m.model))
          .map((m: any) => {
            const id = m.name || m.model;
            const paramSize = m.details?.parameter_size ? `${m.details.parameter_size} ` : "";
            const family = m.details?.family ? `(${m.details.family})` : "";
            const desc = `${paramSize}${family}`.trim() || "Local Ollama model";
            const reasoningCap = detectReasoningCapability(id, { name: id }, cleanBase);
            return {
              id,
              name: id,
              description: desc,
              category: categorizeModel(id, id, desc),
              supportsReasoning: reasoningCap.supported,
              supportedReasoningEfforts: reasoningCap.efforts,
              isLive: false,
            };
          });
      }
    } catch {
      // Ignore if not an Ollama instance
    }
  }

  // Ensure user's currently configured model ID is included for testing if endpoint or fallback is active
  const cleanPreferred = (preferredModel || "").trim();
  if (
    cleanPreferred &&
    !candidates.some((c) => c.id === cleanPreferred) &&
    !fallbackCandidates.some((fc) => fc.id === cleanPreferred)
  ) {
    fallbackCandidates = [
      {
        id: cleanPreferred,
        name: cleanPreferred,
        category: categorizeModel(cleanPreferred, cleanPreferred),
        isLive: false,
      },
      ...fallbackCandidates,
    ];
  }

  // Merge fallbackCandidates for endpoints like Coding Plan where /models may be absent or incomplete
  if (fallbackCandidates.length > 0 && (candidates.length === 0 || cleanBase.includes("coding"))) {
    if (!endpointAlive) {
      // Quick canary check so invalid keys fail in 1 request instead of testing the whole list
      const canary = await verifyOpenAICompatibleModel(
        cleanBase,
        key,
        fallbackCandidates[0].id
      );
      if (canary.fatalAuth) return null;
    }
    const existingIds = new Set(candidates.map((c) => c.id));
    for (const fc of fallbackCandidates) {
      if (!existingIds.has(fc.id)) {
        candidates.push({
          ...fc,
          category: fc.category || categorizeModel(fc.id, fc.name, fc.description),
        });
      }
    }
  } else if (endpointAlive && cleanPreferred && !candidates.some((c) => c.id === cleanPreferred)) {
    candidates.push({
      id: cleanPreferred,
      name: cleanPreferred,
      category: categorizeModel(cleanPreferred, cleanPreferred),
      isLive: false,
    });
  } else if (!endpointAlive && candidates.length === 0) {
    return null;
  }

  if (candidates.length === 0) {
    return null;
  }

  // Deduplicate snapshots and balance candidates across all capability families
  const toVerify = prioritizeMultiModelCandidates(candidates, cleanPreferred, 44);

  onProgress?.({
    phase: "verifying",
    message: `Testing key access permissions across ${toVerify.length} ${providerTitle} models...`,
    provider: "openai-compatible",
    providerTitle,
    checked: 0,
    total: toVerify.length,
    verifiedModels: [],
  });

  const poolResult = await verifyCandidatesInPool(
    toVerify,
    (id) => verifyOpenAICompatibleModel(cleanBase, key, id),
    (verifiedSoFar, checked, total) => {
      onProgress?.({
        phase: "verifying",
        message: `Verifying ${providerTitle} (${checked}/${total} tested — ${verifiedSoFar.length} callable)...`,
        provider: "openai-compatible",
        providerTitle,
        checked,
        total,
        verifiedModels: verifiedSoFar,
      });
    },
    signal,
    5
  );

  if (poolResult.fatalAuth) {
    return null;
  }

  return {
    success: poolResult.verified.length > 0,
    provider: "openai-compatible",
    providerTitle,
    baseUrl: cleanBase,
    isLiveApi: poolResult.verified.length > 0,
    models: poolResult.verified,
    rejectedCount: poolResult.rejectedCount,
    error:
      poolResult.verified.length === 0
        ? `Key connected to ${providerTitle}, but 0/${toVerify.length} models succeeded (${poolResult.lastError}).`
        : undefined,
  };
}

/**
 * Main entry point: Identifies and live-verifies callable models strictly
 * through the user's configured API Key and Base URL.
 */
export async function identifyKeyAndVerifyModels(
  settings: AISidepanelSettings,
  options?: {
    onProgress?: (progress: ScanProgress) => void;
    signal?: AbortSignal;
  }
): Promise<KeyIdentificationResult> {
  const cleanKey = (settings.apiKey || "").trim();
  const cleanBase = (settings.baseUrl || "")
    .trim()
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");
  const preferredModel = (settings.model || "").trim();
  const onProgress = options?.onProgress;
  const signal = options?.signal;

  if (!cleanBase) {
    return {
      success: false,
      provider: "openai-compatible",
      providerTitle: "No Endpoint",
      baseUrl: "",
      isLiveApi: false,
      models: [],
      rejectedCount: 0,
      error: "No Base URL configured. Enter both your Base URL and API Key in Settings to identify attached models.",
    };
  }

  const protocol = inferProtocolFromBaseUrl(cleanBase);
  const providerTitle = getProviderLabelFromBaseUrl(cleanBase);

  if (!cleanKey && !isLocalBaseUrl(cleanBase)) {
    return {
      success: false,
      provider: protocol,
      providerTitle,
      baseUrl: cleanBase,
      isLiveApi: false,
      models: [],
      rejectedCount: 0,
      error: "No API key configured. Enter your API key and Base URL to identify attached models.",
    };
  }

  onProgress?.({
    phase: "authenticating",
    message: `Connecting to ${cleanBase} with your API key...`,
    provider: protocol,
    providerTitle,
    checked: 0,
    total: 0,
    verifiedModels: [],
  });

  if (protocol === "gemini") {
    const res = await scanGemini(cleanBase, cleanKey, preferredModel, onProgress, signal);
    if (res) return res;
  } else if (protocol === "anthropic") {
    const res = await scanAnthropic(cleanBase, cleanKey, preferredModel, onProgress, signal);
    if (res) return res;
  } else if (cleanBase.includes("openrouter.ai")) {
    const res = await scanOpenRouter(cleanBase, cleanKey, preferredModel, onProgress, signal);
    if (res) return res;
  } else {
    const fallbackCandidates: AvailableModelItem[] = [];
    if (cleanBase.includes("coding") && cleanBase.includes("dashscope")) {
      fallbackCandidates.push(...QWEN_CODING_PLAN_CANDIDATES);
    }

    const res = await scanOpenAICompatibleEndpoint(
      cleanKey,
      cleanBase,
      providerTitle,
      preferredModel,
      fallbackCandidates,
      onProgress,
      signal
    );
    if (res) return res;
  }

  return {
    success: false,
    provider: protocol,
    providerTitle,
    baseUrl: cleanBase,
    isLiveApi: false,
    models: [],
    rejectedCount: 0,
    error: `Could not verify any callable models at ${cleanBase} with this API key. Check that your API key, Base URL, and model permissions match.`,
  };
}

/**
 * Verifies a single user-specified model ID directly against the configured API key and Base URL
 */
export async function verifySingleCustomModel(
  settings: AISidepanelSettings,
  modelId: string
): Promise<{ ok: boolean; item?: AvailableModelItem; error?: string }> {
  const cleanKey = (settings.apiKey || "").trim();
  const cleanId = modelId.trim();
  const cleanBase = (settings.baseUrl || "")
    .trim()
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");

  if (!cleanId) return { ok: false, error: "Model ID cannot be empty." };
  if (!cleanBase) return { ok: false, error: "No Base URL configured." };
  if (!cleanKey && !isLocalBaseUrl(cleanBase)) {
    return { ok: false, error: "No API key configured." };
  }

  const protocol = inferProtocolFromBaseUrl(cleanBase);
  let res: ProbeModelResult;
  if (protocol === "gemini") {
    res = await verifyGeminiModel(cleanBase, cleanKey, cleanId);
  } else if (protocol === "anthropic") {
    res = await verifyAnthropicModel(cleanBase, cleanKey, cleanId);
  } else {
    res = await verifyOpenAICompatibleModel(cleanBase, cleanKey, cleanId);
  }

  if (res.ok) {
    const reasoningCap = detectReasoningCapability(cleanId, { name: cleanId }, cleanBase);
    return {
      ok: true,
      item: {
        id: cleanId,
        name: cleanId,
        description: "Verified directly with API key and Base URL",
        category: categorizeModel(cleanId, cleanId, ""),
        supportsReasoning: reasoningCap.supported,
        supportedReasoningEfforts: reasoningCap.efforts,
        isLive: true,
      },
    };
  }

  return {
    ok: false,
    error: res.reason || "API rejected this model ID.",
  };
}

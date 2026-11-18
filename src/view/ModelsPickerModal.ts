import { App, Modal, Notice, setIcon } from "obsidian";
import type AISidepanelPlugin from "../main";
import {
  AvailableModelItem,
  identifyKeyAndVerifyModels,
  KeyIdentificationResult,
  ScanProgress,
  verifySingleCustomModel,
} from "../ai/modelScanner";
import {
  categorizeModel,
  detectReasoningCapability,
  getProviderLabelFromBaseUrl,
  getSyncedAttachedModels,
  inferProtocolFromBaseUrl,
  MODEL_CATEGORY_META,
  MODEL_CATEGORY_ORDER,
  ModelCategory,
} from "../types";

export class ModelsPickerModal extends Modal {
  private plugin: AISidepanelPlugin;
  private onSelect?: (modelId: string) => void;
  private onSync?: () => void;
  private forceScan: boolean;
  private searchInput!: HTMLInputElement;
  private categoryBarEl!: HTMLElement;
  private listContainer!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private providerBadgeEl!: HTMLElement;
  private rescanBtnEl!: HTMLButtonElement;
  private allModels: AvailableModelItem[] = [];
  private activeCategory: ModelCategory | "all" = "all";
  private isScanning = false;
  private abortController: AbortController | null = null;

  constructor(
    app: App,
    plugin: AISidepanelPlugin,
    onSelect?: (modelId: string) => void,
    options?: { forceScan?: boolean; onSync?: () => void }
  ) {
    super(app);
    this.plugin = plugin;
    this.onSelect = onSelect;
    this.onSync = options?.onSync;
    this.forceScan = options?.forceScan ?? false;
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("mod-ai-models-modal");

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-models-modal-root");

    // ==========================================
    // Top Header Section
    // ==========================================
    const headerEl = contentEl.createDiv({ cls: "ai-modal-top-bar" });

    const titleBox = headerEl.createDiv({ cls: "ai-modal-title-group" });
    const botIcon = titleBox.createSpan({ cls: "ai-modal-bot-icon" });
    setIcon(botIcon, "bot");

    const textGroup = titleBox.createDiv({ cls: "ai-modal-text-group" });
    textGroup.createEl("h2", { text: "Verified Models Attached to Key", cls: "ai-modal-title" });
    this.statusTextEl = textGroup.createDiv({
      cls: "ai-modal-status-text",
      text: "Authenticating API key and verifying callable models...",
    });

    const badgeGroup = headerEl.createDiv({ cls: "ai-modal-badge-group" });

    // Re-scan Button
    this.rescanBtnEl = badgeGroup.createEl("button", {
      cls: "clickable-icon ai-modal-rescan-btn",
      attr: { title: "Re-scan & Live Test Models" },
    });
    setIcon(this.rescanBtnEl, "refresh-cw");
    this.rescanBtnEl.addEventListener("click", () => {
      if (!this.isScanning) {
        void this.scanAndPopulateModels();
      }
    });

    this.providerBadgeEl = badgeGroup.createSpan({
      cls: "ai-modal-provider-badge",
      text: getProviderLabelFromBaseUrl(this.plugin.settings.baseUrl).toUpperCase(),
    });

    // ==========================================
    // Search Bar & Category Filter Bar
    // ==========================================
    const searchWrapper = contentEl.createDiv({ cls: "ai-modal-search-wrapper" });
    const searchIconSpan = searchWrapper.createSpan({ cls: "ai-modal-search-icon" });
    setIcon(searchIconSpan, "search");

    this.searchInput = searchWrapper.createEl("input", {
      type: "text",
      cls: "ai-modal-search-box",
      attr: {
        placeholder: "Filter verified models by name, family, or ID...",
      },
    });

    this.searchInput.addEventListener("input", () => {
      this.renderModelGrid(this.searchInput.value);
    });

    this.categoryBarEl = contentEl.createDiv({ cls: "ai-modal-category-bar hidden" });

    // ==========================================
    // Scrollable Grid of Models
    // ==========================================
    this.listContainer = contentEl.createDiv({ cls: "ai-modal-cards-grid" });

    // ==========================================
    // Footer Section: Test & Verify Specific Model
    // ==========================================
    const footerEl = contentEl.createDiv({ cls: "ai-modal-footer" });
    const customHeader = footerEl.createDiv({ cls: "ai-modal-footer-header" });
    customHeader.createSpan({
      cls: "ai-modal-custom-title",
      text: "Test & verify a specific model ID directly against your API key:",
    });

    const customRow = footerEl.createDiv({ cls: "ai-modal-footer-input-row" });
    const customInput = customRow.createEl("input", {
      type: "text",
      cls: "ai-modal-custom-field",
      attr: { placeholder: "e.g. qwen3.5-plus, gpt-4o, gemini-2.5-flash" },
      value: this.plugin.settings.model,
    });

    const customApplyBtn = customRow.createEl("button", {
      cls: "mod-cta ai-modal-apply-btn",
      text: "Test & Use",
    });

    const testCustomModel = async () => {
      const val = customInput.value.trim();
      if (!val || this.isScanning) return;

      const origText = customApplyBtn.textContent || "Test & Use";
      customApplyBtn.textContent = "Testing...";
      customApplyBtn.setAttr("disabled", "true");

      const check = await verifySingleCustomModel(this.plugin.settings, val);

      customApplyBtn.removeAttribute("disabled");
      customApplyBtn.textContent = origText;

      if (check.ok && check.item) {
        await this.plugin.registerVerifiedModel(check.item, true);
        if (this.onSelect) {
          this.onSelect(check.item.id);
        }
        new Notice(`Verified & active model set to: ${check.item.id}`);
        this.close();
      } else {
        new Notice(`Model "${val}" rejected by key: ${check.error || "Unauthorized"}`, 6000);
        this.statusTextEl.setText(`⚠️ Custom model "${val}" failed check: ${check.error}`);
      }
    };

    customApplyBtn.addEventListener("click", () => {
      void testCustomModel();
    });

    customInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void testCustomModel();
      }
    });

    // ==========================================
    // Load Synced Multi-Model Catalog or Run Live Scan
    // ==========================================
    const synced = getSyncedAttachedModels(this.plugin.settings);
    if (!this.forceScan && synced.length > 0) {
      const providerTitle = getProviderLabelFromBaseUrl(this.plugin.settings.baseUrl);
      this.allModels = synced;
      this.providerBadgeEl.setText(
        `${providerTitle.toUpperCase()} • ${
          synced.length > 1 ? `${synced.length} MODELS` : "VERIFIED"
        }`
      );
      this.providerBadgeEl.addClass("live");
      this.statusTextEl.setText(
        synced.length > 1
          ? `✅ Multi-Model Host: ${synced.length} callable models verified on ${providerTitle}. Click 🔄 to re-scan.`
          : `✅ Verified 1 callable model on ${providerTitle}. Click 🔄 to re-scan.`
      );
      this.renderCategoryBar();
      this.renderModelGrid("");
      this.searchInput.focus();
    } else {
      await this.scanAndPopulateModels();
    }
  }

  private async scanAndPopulateModels(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.isScanning = true;
    this.activeCategory = "all";
    this.allModels = [];
    this.rescanBtnEl?.addClass("spinning");
    this.categoryBarEl.empty();
    this.categoryBarEl.addClass("hidden");
    this.providerBadgeEl.removeClass("live");
    this.statusTextEl.setText("🔍 Authenticating key & verifying callable models...");
    this.listContainer.empty();

    const loadingEl = this.listContainer.createDiv({ cls: "ai-modal-loading-state" });
    loadingEl.createDiv({ cls: "ai-modal-spinner" });
    loadingEl.createSpan({
      text: "Running live permission checks — ONLY models that actually respond 200 OK will be listed...",
    });

    let hasRenderedPartial = false;

    try {
      const result: KeyIdentificationResult = await identifyKeyAndVerifyModels(
        this.plugin.settings,
        {
          signal,
          onProgress: (progress: ScanProgress) => {
            if (signal.aborted) return;

            this.statusTextEl.setText(`🔍 ${progress.message}`);

            if (progress.providerTitle) {
              this.providerBadgeEl.setText(`${progress.providerTitle.toUpperCase()} • PROBING`);
            }

            if (progress.verifiedModels.length > 0) {
              this.allModels = progress.verifiedModels;
              hasRenderedPartial = true;
              this.renderCategoryBar();
              this.renderModelGrid(this.searchInput.value);
            }
          },
        }
      );

      if (signal.aborted) return;

      if (result.success && result.isLiveApi && result.models.length > 0) {
        this.plugin.settings.provider = inferProtocolFromBaseUrl(
          this.plugin.settings.baseUrl
        );
        this.plugin.settings.attachedModels = result.models;
        this.plugin.settings.lastIdentifiedKey = this.plugin.settings.apiKey;
        this.plugin.settings.lastIdentifiedBaseUrl = this.plugin.settings.baseUrl;
        this.plugin.settings.lastIdentifiedProvider = result.providerTitle;
        this.plugin.settings.modelScanVersion = 3;

        if (!result.models.some((m) => m.id === this.plugin.settings.model)) {
          this.plugin.settings.model = result.models[0].id;
        }

        await this.plugin.saveSettings();
        this.onSync?.();

        const isMulti = result.models.length > 1;
        this.providerBadgeEl.setText(
          `${result.providerTitle.toUpperCase()} • ${
            isMulti ? `${result.models.length} MODELS` : "VERIFIED"
          }`
        );
        this.providerBadgeEl.addClass("live");

        const rejectedNote =
          result.rejectedCount > 0
            ? ` (${result.rejectedCount} unauthorized/unattached filtered out)`
            : "";

        this.statusTextEl.setText(
          isMulti
            ? `✅ Multi-Model Host Confirmed: ${result.models.length} callable models on ${result.providerTitle}${rejectedNote}.`
            : `✅ Confirmed 1 callable model on ${result.providerTitle}${rejectedNote}.`
        );

        this.allModels = result.models;
      } else {
        this.providerBadgeEl.setText(
          getProviderLabelFromBaseUrl(this.plugin.settings.baseUrl).toUpperCase()
        );
        this.providerBadgeEl.removeClass("live");

        this.plugin.settings.attachedModels = [];
        this.plugin.settings.lastIdentifiedKey = "";
        this.plugin.settings.lastIdentifiedBaseUrl = "";
        await this.plugin.saveSettings();
        this.onSync?.();

        this.statusTextEl.setText(
          `⚠️ ${result.error || "No callable models were confirmed for this API key."}`
        );

        this.allModels = [];
      }

      this.renderCategoryBar();
      if (this.allModels.length > 0 || !hasRenderedPartial) {
        this.renderModelGrid(this.searchInput.value);
      }
      this.searchInput.focus();
    } catch (err: unknown) {
      if (!signal.aborted) {
        const errMsg = err instanceof Error ? err.message : "Unable to reach provider API";
        this.statusTextEl.setText(`⚠️ Connection error: ${errMsg}`);
        this.allModels = [];
        this.plugin.settings.attachedModels = [];
        await this.plugin.saveSettings();
        this.onSync?.();
        this.renderCategoryBar();
        this.renderModelGrid("");
      }
    } finally {
      this.isScanning = false;
      this.rescanBtnEl?.removeClass("spinning");
    }
  }

  private getModelCategory(m: AvailableModelItem): ModelCategory {
    return (
      (m.category as ModelCategory) ||
      categorizeModel(m.id, m.name, m.description)
    );
  }

  private renderCategoryBar(): void {
    this.categoryBarEl.empty();

    if (this.allModels.length <= 1) {
      this.categoryBarEl.addClass("hidden");
      return;
    }

    const counts = new Map<ModelCategory, number>();
    for (const m of this.allModels) {
      const cat = this.getModelCategory(m);
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }

    const populatedCategories = MODEL_CATEGORY_ORDER.filter(
      (c) => (counts.get(c) || 0) > 0
    );
    if (populatedCategories.length <= 1) {
      this.categoryBarEl.addClass("hidden");
      return;
    }

    this.categoryBarEl.removeClass("hidden");

    const addTab = (
      id: ModelCategory | "all",
      label: string,
      count: number,
      iconName?: string
    ) => {
      const btn = this.categoryBarEl.createEl("button", {
        cls: `ai-modal-cat-tab ${this.activeCategory === id ? "active" : ""}`,
      });
      if (iconName) {
        const iconEl = btn.createSpan({ cls: "ai-cat-tab-icon" });
        setIcon(iconEl, iconName);
      }
      btn.createSpan({ text: label });
      btn.createSpan({ cls: "ai-cat-tab-count", text: String(count) });
      btn.addEventListener("click", () => {
        this.activeCategory = id;
        this.renderCategoryBar();
        this.renderModelGrid(this.searchInput.value);
      });
    };

    addTab("all", "All Families", this.allModels.length, "layers");
    for (const cat of populatedCategories) {
      const meta = MODEL_CATEGORY_META[cat];
      addTab(cat, meta.label, counts.get(cat) || 0, meta.icon);
    }
  }

  private renderModelCard(parent: HTMLElement, m: AvailableModelItem): void {
    const isSelected = this.plugin.settings.model === m.id;
    const cat = this.getModelCategory(m);
    const catMeta = MODEL_CATEGORY_META[cat];

    const card = parent.createDiv({
      cls: `ai-model-grid-card ${isSelected ? "selected" : ""}`,
    });

    const topRow = card.createDiv({ cls: "ai-card-title-row" });
    topRow.createSpan({
      text: m.name || m.id,
      cls: "ai-card-model-name",
    });

    if (isSelected) {
      const badge = topRow.createSpan({ cls: "ai-card-selected-tag" });
      setIcon(badge, "check");
      badge.createSpan({ text: " Active" });
    }

    const idTag = card.createDiv({ cls: "ai-card-id-pill" });
    idTag.setText(m.id);

    if (m.description) {
      card.createDiv({ cls: "ai-card-desc", text: m.description });
    }

    const tagsGroup = card.createDiv({ cls: "ai-card-tags-group ai-card-meta-row" });

    const catPill = tagsGroup.createSpan({
      cls: `ai-card-category-pill cat-${cat}`,
      attr: { title: catMeta.label },
    });
    const catIcon = catPill.createSpan({ cls: "ai-card-cat-icon" });
    setIcon(catIcon, catMeta.icon);
    catPill.createSpan({ text: catMeta.shortLabel });

    const reasoningCap = detectReasoningCapability(
      m.id,
      m,
      this.plugin.settings.baseUrl
    );
    if (reasoningCap.supported) {
      const reasonPill = tagsGroup.createSpan({
        cls: "ai-card-reasoning-pill",
        attr: { title: "Supports configurable reasoning / thinking levels" },
      });
      const reasonIcon = reasonPill.createSpan({ cls: "ai-card-cat-icon" });
      setIcon(reasonIcon, "brain");
      reasonPill.createSpan({ text: "Reasoning" });
    }

    if (m.isLive) {
      tagsGroup.createSpan({
        cls: "ai-card-live-pill",
        text: "VERIFIED",
        attr: { title: "Live-tested 200 OK with your API key" },
      });
    }

    card.addEventListener("click", () => {
      void this.selectModel(m.id);
    });
  }

  private renderModelGrid(filterText: string): void {
    this.listContainer.empty();

    if (this.allModels.length === 0) {
      const emptyState = this.listContainer.createDiv({ cls: "ai-modal-no-results" });
      const emptyIcon = emptyState.createSpan({ cls: "ai-modal-empty-icon" });
      setIcon(emptyIcon, "shield-alert");
      emptyState.createDiv({
        cls: "ai-modal-empty-title",
        text: "No Callable Models Attached to This Key",
      });
      emptyState.createDiv({
        cls: "ai-modal-empty-desc",
        text: "Every candidate model returned an error or lacked permissions/quota for this API key. Check your key permissions, region Base URL, or account balance, or test a specific model ID below.",
      });
      return;
    }

    const query = filterText.toLowerCase().trim();
    const filtered = this.allModels.filter((m) => {
      const cat = this.getModelCategory(m);
      if (this.activeCategory !== "all" && cat !== this.activeCategory) {
        return false;
      }
      if (!query) return true;
      const catLabel = MODEL_CATEGORY_META[cat].label.toLowerCase();
      return (
        m.id.toLowerCase().includes(query) ||
        (m.name && m.name.toLowerCase().includes(query)) ||
        (m.description && m.description.toLowerCase().includes(query)) ||
        catLabel.includes(query)
      );
    });

    if (filtered.length === 0) {
      const emptyState = this.listContainer.createDiv({ cls: "ai-modal-no-results" });
      const emptyIcon = emptyState.createSpan({ cls: "ai-modal-empty-icon" });
      setIcon(emptyIcon, "help-circle");
      emptyState.createDiv({
        cls: "ai-modal-empty-title",
        text: filterText
          ? `No verified models matched "${filterText}"`
          : "No models in this category",
      });
      emptyState.createDiv({
        cls: "ai-modal-empty-desc",
        text: "Try another filter or test an exact model ID directly using the input at the bottom.",
      });
      return;
    }

    // Group cards by capability family when viewing "All Families" and >1 category exists
    const categoriesPresent = new Set(filtered.map((m) => this.getModelCategory(m)));
    if (this.activeCategory === "all" && categoriesPresent.size > 1) {
      for (const cat of MODEL_CATEGORY_ORDER) {
        const items = filtered.filter((m) => this.getModelCategory(m) === cat);
        if (items.length === 0) continue;

        const meta = MODEL_CATEGORY_META[cat];
        const groupHeader = this.listContainer.createDiv({ cls: "ai-modal-group-header" });
        const iconEl = groupHeader.createSpan({ cls: "ai-group-header-icon" });
        setIcon(iconEl, meta.icon);
        groupHeader.createSpan({ cls: "ai-group-header-title", text: meta.label });
        groupHeader.createSpan({ cls: "ai-group-header-count", text: String(items.length) });

        for (const m of items) {
          this.renderModelCard(this.listContainer, m);
        }
      }
    } else {
      for (const m of filtered) {
        this.renderModelCard(this.listContainer, m);
      }
    }
  }

  private async selectModel(modelId: string): Promise<void> {
    this.plugin.settings.model = modelId;
    await this.plugin.saveSettings();
    if (this.onSelect) {
      this.onSelect(modelId);
    }
    new Notice(`Active Model set to: ${modelId}`);
    this.close();
  }

  onClose(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    const { contentEl } = this;
    contentEl.empty();
  }
}

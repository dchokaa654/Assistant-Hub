import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type AISidepanelPlugin from "./main";
import {
  categorizeModel,
  DEFAULT_SETTINGS,
  detectReasoningCapability,
  getProviderLabelFromBaseUrl,
  getSyncedAttachedModels,
  isLocalBaseUrl,
  MODEL_CATEGORY_META,
  MODEL_CATEGORY_ORDER,
  ModelCategory,
  ProviderProfile,
} from "./types";
import { ModelsPickerModal } from "./view/ModelsPickerModal";

const CONNECTION_PRESETS: { label: string; baseUrl: string }[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "Anthropic", baseUrl: "https://api.anthropic.com" },
  { label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
];

class ConnectionEditorModal extends Modal {
  private nameVal: string;
  private baseUrlVal: string;
  private apiKeyVal: string;

  constructor(
    app: App,
    private plugin: AISidepanelPlugin,
    private existingProfile: ProviderProfile | null,
    private onSaved: (profileId: string, verifyModels: boolean) => void
  ) {
    super(app);
    this.nameVal = existingProfile?.name || "";
    this.baseUrlVal = existingProfile?.baseUrl || "";
    this.apiKeyVal = existingProfile?.apiKey || "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-connection-editor-modal");

    contentEl.createEl("h3", {
      text: this.existingProfile
        ? `Edit Connection: ${this.existingProfile.name}`
        : "Add API Connection",
    });

    // Quick provider presets
    const presetsWrap = contentEl.createDiv({ cls: "ai-connection-presets" });
    presetsWrap.createSpan({
      cls: "ai-presets-label",
      text: "Quick Presets:",
    });

    let nameInputEl: HTMLInputElement;
    let urlInputEl: HTMLInputElement;

    for (const preset of CONNECTION_PRESETS) {
      const chip = presetsWrap.createEl("button", {
        cls: "ai-preset-chip",
        text: preset.label,
        attr: { type: "button" },
      });
      chip.addEventListener("click", () => {
        this.baseUrlVal = preset.baseUrl;
        if (urlInputEl) urlInputEl.value = preset.baseUrl;
        if (!this.nameVal.trim() || this.nameVal === "New Connection") {
          this.nameVal = preset.label;
          if (nameInputEl) nameInputEl.value = preset.label;
        }
      });
    }

    new Setting(contentEl)
      .setName("Connection Name")
      .setDesc("Friendly label shown in the profile switcher & model picker.")
      .addText((text) => {
        nameInputEl = text.inputEl;
        text
          .setPlaceholder("e.g. OpenAI, Anthropic, Gemini, Local Ollama")
          .setValue(this.nameVal)
          .onChange((v) => {
            this.nameVal = v;
          });
      });

    new Setting(contentEl)
      .setName("Base URL")
      .setDesc("API endpoint URL for this provider.")
      .addText((text) => {
        urlInputEl = text.inputEl;
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.baseUrlVal)
          .onChange((v) => {
            this.baseUrlVal = v;
          });
      });

    let keyInputEl: HTMLInputElement;
    new Setting(contentEl)
      .setName("API Key")
      .setDesc("API key for this endpoint (optional for local Ollama).")
      .addText((text) => {
        keyInputEl = text.inputEl;
        text.inputEl.type = "password";
        text
          .setPlaceholder("Paste API key here...")
          .setValue(this.apiKeyVal)
          .onChange((v) => {
            this.apiKeyVal = v;
          });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon("eye")
          .setTooltip("Toggle API Key Visibility")
          .onClick(() => {
            keyInputEl.type =
              keyInputEl.type === "password" ? "text" : "password";
          });
      });

    const footer = contentEl.createDiv({ cls: "ai-connection-modal-footer" });

    const cancelBtn = footer.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = footer.createEl("button", {
      text: "Save",
      attr: { type: "button" },
    });

    const saveAndVerifyBtn = footer.createEl("button", {
      cls: "mod-cta",
      text: "Save & Verify Models",
      attr: { type: "button" },
    });

    const commit = async (verifyModels: boolean) => {
      const cleanUrl = this.baseUrlVal.trim();
      const cleanKey = this.apiKeyVal.trim();
      const cleanName =
        this.nameVal.trim() ||
        (cleanUrl ? getProviderLabelFromBaseUrl(cleanUrl) : "") ||
        "Connection";

      if (!cleanUrl) {
        new Notice("Please enter a Base URL.");
        return;
      }

      let savedId = "";
      if (this.existingProfile) {
        const updated = await this.plugin.updateProfile(
          this.existingProfile.id,
          {
            name: cleanName,
            baseUrl: cleanUrl,
            apiKey: cleanKey,
          }
        );
        savedId = updated?.id || this.existingProfile.id;
        await this.plugin.activateProfile(savedId);
      } else {
        const created = await this.plugin.addProfile(
          cleanName,
          cleanUrl,
          cleanKey
        );
        savedId = created.id;
      }

      this.close();
      this.onSaved(savedId, verifyModels);
    };

    saveBtn.addEventListener("click", () => void commit(false));
    saveAndVerifyBtn.addEventListener("click", () => void commit(true));
  }
}

export class AISidepanelSettingTab extends PluginSettingTab {
  plugin: AISidepanelPlugin;
  private keyDebounceTimer: number | null = null;
  private modelsSummaryEl: HTMLElement | null = null;
  private modelTextInputEl: HTMLInputElement | null = null;

  constructor(app: App, plugin: AISidepanelPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    if (this.keyDebounceTimer !== null) {
      window.clearTimeout(this.keyDebounceTimer);
      this.keyDebounceTimer = null;
    }
  }

  private openScannerModal(forceScan: boolean): void {
    new ModelsPickerModal(
      this.app,
      this.plugin,
      () => {
        this.display();
      },
      {
        forceScan,
        onSync: () => {
          if (this.modelTextInputEl) {
            this.modelTextInputEl.value = this.plugin.settings.model;
          }
          this.renderModelsSummary();
        },
      }
    ).open();
  }

  private renderModelsSummary(): void {
    const container = this.modelsSummaryEl;
    if (!container) return;
    container.empty();

    const cleanUrl = (this.plugin.settings.baseUrl || "").trim();
    const cleanKey = (this.plugin.settings.apiKey || "").trim();
    const hasKeyOrLocal = Boolean(cleanKey) || isLocalBaseUrl(cleanUrl);
    const providerLabel = getProviderLabelFromBaseUrl(cleanUrl);
    const synced = getSyncedAttachedModels(this.plugin.settings);

    if (synced.length > 0) {
      const card = container.createDiv({ cls: "ai-settings-summary-card synced" });

      const topRow = card.createDiv({ cls: "ai-settings-summary-top" });
      const titleWrap = topRow.createDiv({ cls: "ai-settings-summary-title" });
      titleWrap.createSpan({ cls: "ai-popup-status-dot online" });
      titleWrap.createSpan({
        text:
          synced.length > 1
            ? `Multi-Model Host: ${synced.length} Verified Models on ${providerLabel}`
            : `Verified 1 Callable Model on ${providerLabel}`,
      });

      const explorerBtn = topRow.createEl("button", {
        cls: "ai-settings-summary-explorer-btn",
        text: "Open Explorer",
      });
      explorerBtn.addEventListener("click", () => this.openScannerModal(false));

      // Family breakdown badges
      const counts = new Map<ModelCategory, number>();
      for (const m of synced) {
        const cat = m.category || categorizeModel(m.id, m.name, m.description);
        counts.set(cat, (counts.get(cat) || 0) + 1);
      }

      const breakdownRow = card.createDiv({ cls: "ai-settings-breakdown-row" });
      for (const cat of MODEL_CATEGORY_ORDER) {
        const n = counts.get(cat) || 0;
        if (n === 0) continue;
        const meta = MODEL_CATEGORY_META[cat];
        const badge = breakdownRow.createSpan({
          cls: `ai-settings-family-badge cat-${cat}`,
        });
        const iconSpan = badge.createSpan({ cls: "ai-card-cat-icon" });
        setIcon(iconSpan, meta.icon);
        badge.createSpan({ text: `${meta.shortLabel}: ${n}` });
      }

      // Clickable Quick-Select Chips (show up to 14 directly inside Settings)
      const chipsRow = card.createDiv({ cls: "ai-settings-chips-row" });
      for (const m of synced.slice(0, 14)) {
        const isSelected = this.plugin.settings.model === m.id;
        const cap = detectReasoningCapability(m.id, m, cleanUrl);
        const chip = chipsRow.createEl("button", {
          cls: `ai-settings-model-chip ${isSelected ? "active" : ""}`,
          text: cap.supported ? `🧠 ${m.id}` : m.id,
          attr: {
            title: `${m.name || m.id}${
              cap.supported ? " (Supports reasoning levels)" : ""
            } — Click to set active`,
          },
        });
        chip.addEventListener("click", () => {
          void (async () => {
            this.plugin.settings.model = m.id;
            await this.plugin.saveSettings();
            if (this.modelTextInputEl) {
              this.modelTextInputEl.value = m.id;
            }
            this.display();
            new Notice(`Active Model set to: ${m.id}`);
          })();
        });
      }

      if (synced.length > 14) {
        const moreBtn = chipsRow.createEl("button", {
          cls: "ai-settings-model-chip more",
          text: `+${synced.length - 14} more...`,
        });
        moreBtn.addEventListener("click", () => this.openScannerModal(false));
      }
      return;
    }

    if (cleanUrl && hasKeyOrLocal) {
      const promptCard = container.createDiv({ cls: "ai-settings-summary-card pending" });
      promptCard.createSpan({
        cls: "ai-settings-summary-pending-text",
        text: `Endpoint ${providerLabel} configured — click "Identify & Verify Models" to discover all callable models attached to this key.`,
      });
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Assistant Hub Settings").setHeading();

    // --- API Connections ---
    new Setting(containerEl).setName("API Connections").setHeading();

    const profiles = this.plugin.getProfiles();
    const activeProfile = this.plugin.getActiveProfile();

    // Connection Profile Switcher + Add Connection
    new Setting(containerEl)
      .setName("Connection Profile")
      .setDesc(
        "Switch your active API key & endpoint, or add multiple connections to use models across different providers."
      )
      .addDropdown((dropdown) => {
        for (const prof of profiles) {
          const modelCount = (prof.attachedModels || []).filter(
            (m) => m.isLive
          ).length;
          const hostLabel = getProviderLabelFromBaseUrl(prof.baseUrl);
          const suffix =
            modelCount > 0
              ? ` (${modelCount} model${modelCount === 1 ? "" : "s"})`
              : hostLabel !== "No Endpoint"
                ? ` (${hostLabel})`
                : "";
          dropdown.addOption(prof.id, `${prof.name}${suffix}`);
        }
        dropdown
          .setValue(activeProfile?.id || "")
          .onChange(async (val) => {
            await this.plugin.activateProfile(val);
            this.display();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("+ Add Connection")
          .setCta()
          .setTooltip("Add another API Key & Base URL connection")
          .onClick(() => {
            new ConnectionEditorModal(
              this.app,
              this.plugin,
              null,
              (_id, verify) => {
                this.display();
                if (verify) {
                  this.openScannerModal(true);
                }
              }
            ).open();
          });
      });

    // Saved Connections List
    const listEl = containerEl.createDiv({ cls: "ai-connections-list" });
    for (const prof of profiles) {
      const isActive = prof.id === activeProfile?.id;
      const modelCount = (prof.attachedModels || []).filter(
        (m) => m.isLive
      ).length;
      const hostLabel = getProviderLabelFromBaseUrl(prof.baseUrl);
      const maskedKey = prof.apiKey
        ? prof.apiKey.length > 8
          ? `${prof.apiKey.slice(0, 4)}…${prof.apiKey.slice(-4)}`
          : "••••"
        : isLocalBaseUrl(prof.baseUrl)
          ? "Local (no key)"
          : "No key set";

      const cardEl = listEl.createDiv({
        cls: `ai-connection-card ${isActive ? "is-active" : ""}`,
      });

      const infoEl = cardEl.createDiv({ cls: "ai-connection-info" });
      const titleRow = infoEl.createDiv({ cls: "ai-connection-title-row" });
      titleRow.createSpan({
        cls: "ai-connection-name",
        text: prof.name || "Connection",
      });
      if (isActive) {
        titleRow.createSpan({
          cls: "ai-connection-badge active",
          text: "Active",
        });
      }
      if (modelCount > 0) {
        titleRow.createSpan({
          cls: "ai-connection-badge count",
          text: `${modelCount} verified`,
        });
      }

      const metaText = `${
        hostLabel !== "No Endpoint" ? hostLabel : "No Base URL"
      }${prof.baseUrl ? ` • ${prof.baseUrl}` : ""} • Key: ${maskedKey}`;
      infoEl.createDiv({
        cls: "ai-connection-meta",
        text: metaText,
      });

      const actionsEl = cardEl.createDiv({ cls: "ai-connection-actions" });

      if (!isActive) {
        const useBtn = actionsEl.createEl("button", {
          text: "Use",
          attr: { type: "button", title: "Set as active connection" },
        });
        useBtn.addEventListener("click", () => {
          void (async () => {
            await this.plugin.activateProfile(prof.id);
            this.display();
          })();
        });
      }

      const scanBtn = actionsEl.createEl("button", {
        text: "Scan",
        attr: {
          type: "button",
          title: "Identify & verify callable models for this connection",
        },
      });
      scanBtn.addEventListener("click", () => {
        void (async () => {
          if (!isActive) {
            await this.plugin.activateProfile(prof.id);
          }
          this.openScannerModal(true);
        })();
      });

      const editBtn = actionsEl.createEl("button", {
        text: "Edit",
        attr: { type: "button", title: "Edit name, Base URL, or API key" },
      });
      editBtn.addEventListener("click", () => {
        new ConnectionEditorModal(
          this.app,
          this.plugin,
          prof,
          (_id, verify) => {
            this.display();
            if (verify) {
              this.openScannerModal(true);
            }
          }
        ).open();
      });

      if (profiles.length > 1) {
        const delBtn = actionsEl.createEl("button", {
          cls: "ai-connection-del-btn",
          attr: { type: "button", title: `Delete "${prof.name}"` },
        });
        setIcon(delBtn, "trash-2");
        delBtn.addEventListener("click", () => {
          void (async () => {
            const removed = await this.plugin.deleteProfile(prof.id);
            if (removed) {
              new Notice(`Deleted connection "${prof.name}".`);
              this.display();
            }
          })();
        });
      }
    }

    this.modelsSummaryEl = containerEl.createDiv({ cls: "ai-settings-models-summary" });
    this.renderModelsSummary();

    // Temperature
    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Higher values make output more creative, lower values make it more focused and deterministic.")
      .addSlider((slider) =>
        slider
          .setLimits(0.0, 1.5, 0.1)
          .setValue(this.plugin.settings.temperature)
          .onChange(async (val) => {
            this.plugin.settings.temperature = val;
            await this.plugin.saveSettings();
          })
      );

    // --- Obsidian Vault Interaction ---
    new Setting(containerEl).setName("Vault Interaction & Agent Tools").setHeading();

    new Setting(containerEl)
      .setName("Enable Vault Agent Tools")
      .setDesc("Allows the AI to search, read, create, edit, move, and delete notes & folders, and interact directly with workspace tabs and the active editor via tool calling.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableVaultTools)
          .onChange(async (val) => {
            this.plugin.settings.enableVaultTools = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-Attach Active Note")
      .setDesc("Automatically injects the title and content of your currently focused note into the chat context.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoIncludeActiveNote)
          .onChange(async (val) => {
            this.plugin.settings.autoIncludeActiveNote = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-Continue Long Tasks")
      .setDesc("Automatically runs multi-step tasks across compact progress checkpoints (with tool-history compression) until complete, without needing to manually click Continue.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoContinueTasks !== false)
          .onChange(async (val) => {
            this.plugin.settings.autoContinueTasks = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Tool Steps per Checkpoint")
      .setDesc("Steps allowed per checkpoint batch before compacting context and handing off (default 25, up to 50).")
      .addSlider((slider) =>
        slider
          .setLimits(1, 50, 1)
          .setValue(Math.min(50, Math.max(1, this.plugin.settings.maxToolIterations || 25)))
          .onChange(async (val) => {
            this.plugin.settings.maxToolIterations = val;
            await this.plugin.saveSettings();
          })
      );

    // --- Custom System Prompt ---
    new Setting(containerEl).setName("System Instructions").setHeading();

    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc("Instructions guiding the AI's personality, formatting, and vault reasoning behavior.")
      .addTextArea((textArea) => {
        textArea.inputEl.rows = 8;
        textArea.inputEl.cols = 60;
        textArea
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (val) => {
            this.plugin.settings.systemPrompt = val;
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon("reset")
          .setTooltip("Reset to default prompt")
          .onClick(async () => {
            this.plugin.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
            await this.plugin.saveSettings();
            this.display();
          });
      });
  }
}

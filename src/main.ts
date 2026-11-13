import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  AISidepanelSettings,
  AttachedModelInfo,
  DEFAULT_SETTINGS,
  Conversation,
  ProviderProfile,
  getProviderLabelFromBaseUrl,
  inferProtocolFromBaseUrl,
} from "./types";
import { AISidepanelSettingTab } from "./settings";
import { AiSidepanelView, AI_VIEW_TYPE } from "./view/AiSidepanelView";

export default class AISidepanelPlugin extends Plugin {
  settings: AISidepanelSettings = DEFAULT_SETTINGS;
  conversations: Conversation[] = [];
  activeConversationId: string = "";
  private isSettingsLoaded: boolean = false;
  private loadSettingsPromise: Promise<void> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register custom ItemView
    this.registerView(
      AI_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new AiSidepanelView(leaf, this)
    );

    // Star/Sparkle Ribbon icon in left sidebar: toggles Assistant Panel open/closed
    this.addRibbonIcon("sparkles", "Toggle Assistant Panel", () => {
      this.toggleView();
    });

    // Command: Open / Toggle Assistant Panel
    this.addCommand({
      id: "toggle-ai-sidepanel",
      name: "Toggle Assistant Panel",
      callback: () => {
        this.toggleView();
      },
    });

    // Command: Send selection to Assistant Panel
    this.addCommand({
      id: "send-selection-to-ai",
      name: "Send selected text to Assistant Panel",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) return;

        const view = await this.activateView();
        if (view) {
          // @ts-ignore
          const inputEl = view.containerEl.querySelector(
            ".ai-sidepanel-textarea"
          ) as HTMLTextAreaElement;
          if (inputEl) {
            inputEl.value = `Regarding this excerpt:\n"""\n${selection}\n"""\n\n`;
            inputEl.focus();
            inputEl.selectionStart = inputEl.value.length;
            inputEl.selectionEnd = inputEl.value.length;
          }
        }
      },
    });

    // Command: Summarize active note
    this.addCommand({
      id: "summarize-active-note",
      name: "Summarize active note in Assistant Panel",
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return;

        const view = await this.activateView();
        if (view) {
          // @ts-ignore
          const inputEl = view.containerEl.querySelector(
            ".ai-sidepanel-textarea"
          ) as HTMLTextAreaElement;
          // @ts-ignore
          const sendBtn = view.containerEl.querySelector(
            ".ai-send-btn"
          ) as HTMLButtonElement;

          if (inputEl && sendBtn) {
            inputEl.value = `Please provide a concise and structured summary of this note with key takeaways and any action items.`;
            sendBtn.click();
          }
        }
      },
    });

    // Settings tab
    this.addSettingTab(new AISidepanelSettingTab(this.app, this));

    // Ensure the sidepanel is opened at default size on startup
    this.app.workspace.onLayoutReady(() => {
      this.activateView();
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(AI_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    if (this.loadSettingsPromise) {
      return this.loadSettingsPromise;
    }

    this.loadSettingsPromise = (async () => {
      try {
        // Layer 1: Standard plugin data.json
        const pluginData = await this.loadData();

        // Layer 2: External Vault-level config (.obsidian/ai-sidepanel-config.json)
        // Survives manual plugin updates, folder re-installations, or git checkouts
        let vaultConfig: any = null;
        try {
          const configDir = this.app.vault.configDir || ".obsidian";
          const vaultConfigPath = `${configDir}/ai-sidepanel-config.json`;
          if (await this.app.vault.adapter.exists(vaultConfigPath)) {
            const raw = await this.app.vault.adapter.read(vaultConfigPath);
            if (raw && raw.trim()) {
              vaultConfig = JSON.parse(raw);
            }
          }
        } catch (err) {
          console.warn("[AI Sidepanel] Could not read vault-level config backup:", err);
        }

        // Layer 3: Web / Electron localStorage
        // Survives even if .obsidian folder contents are wiped or updated
        let localConfig: any = null;
        try {
          if (typeof window !== "undefined" && window.localStorage) {
            const raw = window.localStorage.getItem("obsidian_ai_sidepanel_persistent_config");
            if (raw && raw.trim()) {
              localConfig = JSON.parse(raw);
            }
          }
        } catch (err) {
          console.warn("[AI Sidepanel] Could not read localStorage config backup:", err);
        }

        // Extract settings payload from each store
        const s1 =
          pluginData?.settings ||
          (pluginData && !pluginData.settings && !pluginData.conversations
            ? pluginData
            : null) ||
          {};
        const s2 =
          vaultConfig?.settings ||
          (vaultConfig && !vaultConfig.settings ? vaultConfig : null) ||
          {};
        const s3 =
          localConfig?.settings ||
          (localConfig && !localConfig.settings ? localConfig : null) ||
          {};

        // Merge with DEFAULT_SETTINGS as base
        const mergedSettings: AISidepanelSettings = Object.assign({}, DEFAULT_SETTINGS);

        // Apply backup layers first, then plugin data layer
        Object.assign(mergedSettings, s3);
        Object.assign(mergedSettings, s2);
        Object.assign(mergedSettings, s1);

        // Self-Healing Credential Recovery:
        // If s1 had empty apiKey or baseUrl (common when updating or replacing plugin folder),
        // recover apiKey, baseUrl, and active model from s2 or s3!
        if (!mergedSettings.apiKey?.trim()) {
          const recoveredKey = ((s2.apiKey || s3.apiKey || "") as string).trim();
          if (recoveredKey) {
            mergedSettings.apiKey = recoveredKey;
          }
        }

        if (!mergedSettings.baseUrl?.trim()) {
          const recoveredUrl = ((s2.baseUrl || s3.baseUrl || "") as string).trim();
          if (recoveredUrl) {
            mergedSettings.baseUrl = recoveredUrl;
          }
        }

        if (!mergedSettings.model?.trim()) {
          const recoveredModel = ((s2.model || s3.model || "") as string).trim();
          if (recoveredModel) {
            mergedSettings.model = recoveredModel;
          }
        }

        // If attachedModels was lost, recover from backup stores
        if (!mergedSettings.attachedModels || mergedSettings.attachedModels.length === 0) {
          if (s2.attachedModels && s2.attachedModels.length > 0) {
            mergedSettings.attachedModels = s2.attachedModels;
          } else if (s3.attachedModels && s3.attachedModels.length > 0) {
            mergedSettings.attachedModels = s3.attachedModels;
          }
        }

        // Upgrade default system prompt to include CORE ACTION MANDATE & FORMATTING & STYLE if on older default
        if (
          !mergedSettings.systemPrompt ||
          !mergedSettings.systemPrompt.includes("CORE ACTION MANDATE") ||
          !mergedSettings.systemPrompt.includes("FORMATTING & STYLE")
        ) {
          if (
            !mergedSettings.systemPrompt ||
            mergedSettings.systemPrompt.includes("embedded directly inside Obsidian")
          ) {
            mergedSettings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
          }
        }

        // Upgrade old default maxToolIterations (10) -> 25 for multi-step vault tasks
        if (!mergedSettings.maxToolIterations || mergedSettings.maxToolIterations === 10) {
          mergedSettings.maxToolIterations = DEFAULT_SETTINGS.maxToolIterations;
        }
        if (typeof mergedSettings.autoContinueTasks !== "boolean") {
          mergedSettings.autoContinueTasks = true;
        }

        mergedSettings.provider = inferProtocolFromBaseUrl(mergedSettings.baseUrl);
        this.settings = mergedSettings;
        this.ensureProfilesInitialized();

        // Conversations recovery
        this.conversations =
          pluginData?.conversations ||
          vaultConfig?.conversations ||
          localConfig?.conversations ||
          [];
        this.activeConversationId =
          pluginData?.activeConversationId ||
          vaultConfig?.activeConversationId ||
          localConfig?.activeConversationId ||
          "";

        this.isSettingsLoaded = true;

        // If credentials were recovered from backup because data.json was missing or empty,
        // synchronize all stores immediately
        if (mergedSettings.apiKey || mergedSettings.baseUrl) {
          await this.persistToAllStores();
        }
      } catch (err) {
        console.error("[AI Sidepanel] Critical error during loadSettings:", err);
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        this.isSettingsLoaded = true;
      } finally {
        this.loadSettingsPromise = null;
      }
    })();

    return this.loadSettingsPromise;
  }

  async saveSettings(): Promise<void> {
    if (!this.isSettingsLoaded && this.loadSettingsPromise) {
      await this.loadSettingsPromise;
    }
    this.syncActiveProfileFromTopLevel();
    await this.persistToAllStores();
    this.notifyViewSettingsChanged();
  }

  public ensureProfilesInitialized(): void {
    if (!Array.isArray(this.settings.profiles)) {
      this.settings.profiles = [];
    }
    if (this.settings.profiles.length === 0) {
      const label = getProviderLabelFromBaseUrl(this.settings.baseUrl);
      const initialProfile: ProviderProfile = {
        id: `prof_${Date.now()}`,
        name: label === "No Endpoint" ? "Primary Profile" : label,
        baseUrl: this.settings.baseUrl || "",
        apiKey: this.settings.apiKey || "",
        provider: inferProtocolFromBaseUrl(this.settings.baseUrl || ""),
        model: this.settings.model || "",
        attachedModels: [...(this.settings.attachedModels || [])],
        lastIdentifiedKey: this.settings.lastIdentifiedKey || "",
        lastIdentifiedBaseUrl: this.settings.lastIdentifiedBaseUrl || "",
        lastIdentifiedProvider: this.settings.lastIdentifiedProvider || "",
      };
      this.settings.profiles = [initialProfile];
      this.settings.activeProfileId = initialProfile.id;
      return;
    }

    const active =
      this.settings.profiles.find((p) => p.id === this.settings.activeProfileId) ||
      this.settings.profiles[0];
    this.settings.activeProfileId = active.id;

    // If top-level fields are blank (e.g. partial backup), hydrate from active profile
    if (!this.settings.baseUrl && active.baseUrl) {
      this.applyProfileToTopLevel(active);
    }
  }

  private applyProfileToTopLevel(profile: ProviderProfile): void {
    this.settings.activeProfileId = profile.id;
    this.settings.baseUrl = profile.baseUrl || "";
    this.settings.apiKey = profile.apiKey || "";
    this.settings.provider = inferProtocolFromBaseUrl(profile.baseUrl || "");
    this.settings.model =
      profile.model || profile.attachedModels?.[0]?.id || "";
    this.settings.attachedModels = [...(profile.attachedModels || [])];
    this.settings.lastIdentifiedKey = profile.lastIdentifiedKey || "";
    this.settings.lastIdentifiedBaseUrl = profile.lastIdentifiedBaseUrl || "";
    this.settings.lastIdentifiedProvider = profile.lastIdentifiedProvider || "";
  }

  public syncActiveProfileFromTopLevel(): void {
    this.ensureProfilesInitialized();
    const active = this.getActiveProfile();
    if (!active) return;

    active.baseUrl = this.settings.baseUrl || "";
    active.apiKey = this.settings.apiKey || "";
    active.provider = inferProtocolFromBaseUrl(this.settings.baseUrl || "");
    active.model = this.settings.model || "";
    active.attachedModels = [...(this.settings.attachedModels || [])];
    active.lastIdentifiedKey = this.settings.lastIdentifiedKey || "";
    active.lastIdentifiedBaseUrl = this.settings.lastIdentifiedBaseUrl || "";
    active.lastIdentifiedProvider = this.settings.lastIdentifiedProvider || "";

    if (
      !active.name ||
      active.name === "No Endpoint" ||
      active.name === "New Profile"
    ) {
      const detected = getProviderLabelFromBaseUrl(active.baseUrl);
      if (detected !== "No Endpoint") {
        active.name = detected;
      }
    }
  }

  public getProfiles(): ProviderProfile[] {
    this.ensureProfilesInitialized();
    return this.settings.profiles || [];
  }

  public getActiveProfile(): ProviderProfile | undefined {
    this.ensureProfilesInitialized();
    const profiles = this.settings.profiles || [];
    return (
      profiles.find((p) => p.id === this.settings.activeProfileId) ||
      profiles[0]
    );
  }

  public async activateProfile(
    profileId: string,
    overrideModelId?: string
  ): Promise<void> {
    this.syncActiveProfileFromTopLevel();
    const profiles = this.settings.profiles || [];
    const target = profiles.find((p) => p.id === profileId);
    if (!target) return;

    if (overrideModelId) {
      target.model = overrideModelId;
    }
    this.applyProfileToTopLevel(target);
    await this.persistToAllStores();
    this.notifyViewSettingsChanged();
  }

  public async addProfile(
    name?: string,
    baseUrl: string = "",
    apiKey: string = ""
  ): Promise<ProviderProfile> {
    this.syncActiveProfileFromTopLevel();
    const profiles = this.settings.profiles || [];
    const detected = baseUrl ? getProviderLabelFromBaseUrl(baseUrl) : "";
    const newProfile: ProviderProfile = {
      id: `prof_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name:
        (name || "").trim() ||
        (detected && detected !== "No Endpoint"
          ? detected
          : `Profile ${profiles.length + 1}`),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      provider: inferProtocolFromBaseUrl(baseUrl),
      model: "",
      attachedModels: [],
      lastIdentifiedKey: "",
      lastIdentifiedBaseUrl: "",
      lastIdentifiedProvider: "",
    };
    profiles.push(newProfile);
    this.settings.profiles = profiles;
    this.applyProfileToTopLevel(newProfile);
    await this.persistToAllStores();
    this.notifyViewSettingsChanged();
    return newProfile;
  }

  public async updateProfile(
    profileId: string,
    updates: { name?: string; baseUrl?: string; apiKey?: string }
  ): Promise<ProviderProfile | undefined> {
    this.ensureProfilesInitialized();
    const profiles = this.settings.profiles || [];
    const target = profiles.find((p) => p.id === profileId);
    if (!target) return undefined;

    const nextBaseUrl =
      updates.baseUrl !== undefined ? updates.baseUrl.trim() : target.baseUrl;
    const nextApiKey =
      updates.apiKey !== undefined ? updates.apiKey.trim() : target.apiKey;
    const credsChanged =
      nextBaseUrl !== target.baseUrl || nextApiKey !== target.apiKey;

    if (updates.name !== undefined) {
      target.name = updates.name.trim() || target.name || "Connection";
    }
    target.baseUrl = nextBaseUrl;
    target.apiKey = nextApiKey;
    target.provider = inferProtocolFromBaseUrl(nextBaseUrl);

    if (credsChanged) {
      target.attachedModels = [];
      target.lastIdentifiedKey = "";
      target.lastIdentifiedBaseUrl = "";
      target.lastIdentifiedProvider = "";
    }

    if (this.settings.activeProfileId === target.id) {
      this.applyProfileToTopLevel(target);
    }

    await this.persistToAllStores();
    this.notifyViewSettingsChanged();
    return target;
  }

  public async deleteProfile(profileId: string): Promise<boolean> {
    const profiles = this.settings.profiles || [];
    if (profiles.length <= 1) return false;
    const filtered = profiles.filter((p) => p.id !== profileId);
    if (filtered.length === profiles.length) return false;

    this.settings.profiles = filtered;
    if (this.settings.activeProfileId === profileId) {
      this.applyProfileToTopLevel(filtered[0]);
    }
    await this.persistToAllStores();
    this.notifyViewSettingsChanged();
    return true;
  }

  private async persistToAllStores(): Promise<void> {
    const payload = {
      settings: this.settings,
      conversations: this.conversations,
      activeConversationId: this.activeConversationId,
      lastSaved: Date.now(),
    };

    // Store 1: Standard plugin data.json
    try {
      await this.saveData(payload);
    } catch (err) {
      console.warn("[AI Sidepanel] Could not save to plugin data.json:", err);
    }

    // Store 2: External Vault-level config (.obsidian/ai-sidepanel-config.json)
    try {
      const configDir = this.app.vault.configDir || ".obsidian";
      const vaultConfigPath = `${configDir}/ai-sidepanel-config.json`;
      await this.app.vault.adapter.write(
        vaultConfigPath,
        JSON.stringify(payload, null, 2)
      );
    } catch (err) {
      console.warn("[AI Sidepanel] Could not save to vault-level config backup:", err);
    }

    // Store 3: Web / Electron localStorage
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(
          "obsidian_ai_sidepanel_persistent_config",
          JSON.stringify(payload)
        );
      }
    } catch (err) {
      console.warn("[AI Sidepanel] Could not save to localStorage config backup:", err);
    }
  }

  public notifyViewSettingsChanged(): void {
    const leaves = this.app?.workspace?.getLeavesOfType(AI_VIEW_TYPE) || [];
    for (const leaf of leaves) {
      if (leaf.view instanceof AiSidepanelView) {
        leaf.view.refreshFromSettings();
      }
    }
  }

  public async registerVerifiedModel(
    item: AttachedModelInfo,
    select = true
  ): Promise<void> {
    const current = [...(this.settings.attachedModels || [])];
    const idx = current.findIndex((m) => m.id === item.id);
    if (idx >= 0) {
      current[idx] = { ...current[idx], ...item, isLive: true };
    } else {
      current.unshift({ ...item, isLive: true });
    }
    this.settings.attachedModels = current;
    this.settings.provider = inferProtocolFromBaseUrl(this.settings.baseUrl);
    this.settings.lastIdentifiedKey = this.settings.apiKey;
    this.settings.lastIdentifiedBaseUrl = this.settings.baseUrl;
    this.settings.lastIdentifiedProvider = getProviderLabelFromBaseUrl(
      this.settings.baseUrl
    );
    this.settings.modelScanVersion = 3;
    if (select) {
      this.settings.model = item.id;
    }
    await this.saveSettings();
  }

  async toggleView(): Promise<void> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(AI_VIEW_TYPE);
    const rightSplit = workspace.rightSplit;

    // Check if view is currently open and visible
    if (leaves.length > 0 && rightSplit) {
      // @ts-ignore
      const isCollapsed = rightSplit.collapsed;
      // @ts-ignore
      const isVisible = leaves.some((leaf) => leaf.view instanceof AiSidepanelView && leaf.containerEl?.offsetParent !== null);

      if (!isCollapsed && isVisible) {
        // Toggle close: collapse the right split
        // @ts-ignore
        rightSplit.collapse();
        return;
      }
    }

    // Otherwise open and reveal
    await this.activateView();
  }

  async activateView(): Promise<AiSidepanelView | null> {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(AI_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: AI_VIEW_TYPE,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);

      // Expand right split and lock to default minimum size (280px)
      const rightSplit = workspace.rightSplit;
      if (rightSplit) {
        // @ts-ignore
        if (rightSplit.collapsed) {
          // @ts-ignore
          rightSplit.expand();
        }

        // @ts-ignore
        const currentSize = rightSplit.size || rightSplit.containerEl?.clientWidth;
        if (!currentSize || currentSize < 280) {
          // @ts-ignore
          if (typeof rightSplit.setSize === "function") {
            // @ts-ignore
            rightSplit.setSize(280);
          }
        }
      }

      return leaf.view as AiSidepanelView;
    }

    return null;
  }
}

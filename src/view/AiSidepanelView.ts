import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  MarkdownView,
  setIcon,
  Notice,
  TFile,
  TFolder,
} from "obsidian";
import type AISidepanelPlugin from "../main";
import {
  categorizeModel,
  ChatMessage,
  detectReasoningCapability,
  getActiveModelReasoningCapability,
  getProviderLabelFromBaseUrl,
  getSyncedAttachedModels,
  isLocalBaseUrl,
  MODEL_CATEGORY_META,
  MODEL_CATEGORY_ORDER,
  ModelCategory,
  NoteChangeRecord,
  REASONING_EFFORT_OPTIONS,
  ReasoningEffort,
  ToolActivityRecord,
} from "../types";
import { verifySingleCustomModel } from "../ai/modelScanner";
import { UnifiedAIClient } from "../ai/provider";
import { VaultToolExecutor } from "../ai/tools";
import { ModelsPickerModal } from "./ModelsPickerModal";
import { RevertConfirmModal } from "./RevertConfirmModal";

export const AI_VIEW_TYPE = "obsidian-ai-sidepanel-view";

interface MentionCandidate {
  kind: "note" | "folder";
  title: string;
  path: string;
  subtitle: string;
  mtime: number;
  file?: TFile;
  folder?: TFolder;
}

interface AttachedMentionItem {
  kind: "note" | "folder";
  path: string;
  label: string;
}

interface AppWithSettings {
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
}

export class AiSidepanelView extends ItemView {
  plugin: AISidepanelPlugin;
  messages: ChatMessage[] = [];
  aiClient: UnifiedAIClient;
  toolExecutor: VaultToolExecutor;

  // UI elements
  private rootEl!: HTMLElement;
  private drawerEl!: HTMLElement;
  private mainChatEl!: HTMLElement;
  private chatContainerEl!: HTMLElement;
  private inputWrapperEl!: HTMLElement;
  private mentionBarEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private mentionBtnEl!: HTMLButtonElement;
  private sendBtnEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private activeNoteBadgeEl!: HTMLElement;
  private modelPillEl!: HTMLElement;
  private reasoningPillEl!: HTMLElement;
  private popupCardEl: HTMLElement | null = null;
  private reasoningPopupEl: HTMLElement | null = null;
  private mentionPopupEl: HTMLElement | null = null;
  private mentionSearchInputEl: HTMLInputElement | null = null;
  private mentionResultsEl: HTMLElement | null = null;

  // State
  private abortController: AbortController | null = null;
  private isGenerating: boolean = false;
  private attachActiveNote: boolean = true;
  private isDrawerOpen: boolean = false;
  private isModelPopupOpen: boolean = false;
  private isReasoningPopupOpen: boolean = false;
  private isMentionPopupOpen: boolean = false;
  private mentionTriggerMode: "button" | "inline" = "button";
  private mentionReplaceStart: number = 0;
  private mentionReplaceEnd: number = 0;
  private mentionMatches: MentionCandidate[] = [];
  private mentionActiveIdx: number = 0;
  private attachedMentions: AttachedMentionItem[] = [];
  private currentConversationId: string = "";
  private liveAssistantMsg: ChatMessage | null = null;
  private activityExpandedState = new WeakMap<ChatMessage, boolean>();
  private changesExpandedState = new WeakMap<ChatMessage, boolean>();
  private stepDetailExpanded = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: AISidepanelPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.toolExecutor = new VaultToolExecutor(this.app);
    this.aiClient = new UnifiedAIClient(this.plugin.settings, this.toolExecutor);
    this.attachActiveNote = this.plugin.settings.autoIncludeActiveNote;
  }

  getViewType(): string {
    return AI_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Assistant Panel";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.rootEl = container.createDiv({ cls: "ai-sidepanel-root" });

    // Filter out any blank placeholder conversations from storage
    this.plugin.conversations = (this.plugin.conversations || []).filter(
      (c) => c.messages && c.messages.some((m) => m.role === "user")
    );

    if (this.plugin.conversations.length > 0) {
      const activeId = this.plugin.activeConversationId;
      const found = this.plugin.conversations.find((c) => c.id === activeId);
      if (found) {
        this.currentConversationId = found.id;
        this.messages = [...found.messages];
      } else {
        const first = this.plugin.conversations[0];
        this.currentConversationId = first.id;
        this.messages = [...first.messages];
      }
    } else {
      this.currentConversationId = `conv_${Date.now()}`;
      this.messages = [this.createDefaultGreetingMessage()];
      this.plugin.activeConversationId = "";
    }

    // Build Layout: Collapsible Drawer + Main Content Area
    this.renderDrawer();
    this.renderMainContent();

    // Listen to editor active note changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateActiveNoteBar();
      })
    );

    // Global click listener to close popups and drawer when clicking outside
    this.registerDomEvent(document, "click", (e: MouseEvent) => {
      const target = e.target as Node;

      // Close model popup if clicked outside
      if (this.isModelPopupOpen && this.popupCardEl) {
        const pillTrigger = this.modelPillEl;
        if (
          !this.popupCardEl.contains(target) &&
          (!pillTrigger || !pillTrigger.contains(target))
        ) {
          this.closeModelPopup();
        }
      }

      // Close reasoning effort popup if clicked outside
      if (this.isReasoningPopupOpen && this.reasoningPopupEl) {
        if (
          !this.reasoningPopupEl.contains(target) &&
          (!this.reasoningPillEl || !this.reasoningPillEl.contains(target))
        ) {
          this.closeReasoningPopup();
        }
      }

      // Close @ Note mention popup if clicked outside
      if (this.isMentionPopupOpen && this.mentionPopupEl) {
        const clickedTriggerBtn =
          this.mentionBtnEl && this.mentionBtnEl.contains(target);
        const clickedTextareaInline =
          this.mentionTriggerMode === "inline" &&
          this.inputEl &&
          this.inputEl.contains(target);
        if (
          !this.mentionPopupEl.contains(target) &&
          !clickedTriggerBtn &&
          !clickedTextareaInline
        ) {
          this.closeMentionPopup();
        }
      }

      // Close drawer if clicked outside on main chat area
      if (this.isDrawerOpen && this.drawerEl) {
        const toggleBtn = this.mainChatEl?.querySelector(".ai-history-toggle-btn");
        if (
          !this.drawerEl.contains(target) &&
          (!toggleBtn || !toggleBtn.contains(target))
        ) {
          this.toggleDrawer(false);
        }
      }
    });

    await this.renderMessages();
  }

  private createDefaultGreetingMessage(): ChatMessage {
    return {
      role: "assistant",
      content: `👋 **Welcome to Assistant Panel!**

I have direct access to your Obsidian notes, folders, workspace tabs, and knowledge graph. You can ask me to:
- 📁 **Organize Notes & Folders**: Create, edit, patch, rename/move, or safely delete notes and folders
- 📑 **Control Your Workspace**: Inspect open tabs, open notes in split panes, or edit text directly in your active editor
- 🔍 **Search & Explore**: Browse the full vault tree or search across all notes, files, and folders
- 🕸️ **Knowledge Graph**: Trace connection paths, analyze hubs & orphans, or link related notes with \`[[wikilinks]]\`

*Every note or folder change can be safely reviewed and reverted from the message actions.* How can I assist you?`,
    };
  }

  // ==========================================
  // Collapsible Conversation History Drawer
  // ==========================================
  private renderDrawer(): void {
    this.drawerEl = this.rootEl.createDiv({
      cls: `ai-sidepanel-drawer ${this.isDrawerOpen ? "open" : "collapsed"}`,
    });

    // Drawer Header
    const drawerHeader = this.drawerEl.createDiv({ cls: "ai-drawer-header" });
    drawerHeader.createSpan({
      text: "Conversations",
      cls: "ai-drawer-title",
    });

    const headerActions = drawerHeader.createDiv({ cls: "ai-drawer-header-actions" });

    // Collapse conversation sidebar button placed on the top right corner of the drawer
    const collapseBtn = headerActions.createEl("button", {
      cls: "clickable-icon ai-drawer-collapse-btn",
      attr: { title: "Collapse Conversations", "aria-label": "Collapse Conversations" },
    });
    setIcon(collapseBtn, "panel-left-close");
    collapseBtn.addEventListener("click", () => {
      this.toggleDrawer(false);
    });

    // Drawer Conversation List
    const listEl = this.drawerEl.createDiv({ cls: "ai-drawer-list" });
    this.updateDrawerList(listEl);
  }

  private updateDrawerList(listEl?: HTMLElement): void {
    const listContainer = listEl || (this.drawerEl?.querySelector(".ai-drawer-list") as HTMLElement);
    if (!listContainer) return;
    listContainer.empty();

    // Only show real saved conversations with user interactions
    const validConvs = (this.plugin.conversations || []).filter(
      (c) => c.messages && c.messages.some((m) => m.role === "user")
    );

    if (validConvs.length === 0) {
      // Empty conversation drawer list as requested
      return;
    }

    // Sort by updated time descending
    const sorted = [...validConvs].sort(
      (a, b) => b.updatedAt - a.updatedAt
    );

    for (const conv of sorted) {
      const itemEl = listContainer.createDiv({
        cls: `ai-drawer-item ${conv.id === this.currentConversationId ? "active" : ""}`,
      });

      const iconSpan = itemEl.createSpan({ cls: "ai-drawer-item-icon" });
      setIcon(iconSpan, "message-square");

      itemEl.createSpan({
        cls: "ai-drawer-item-title",
        text: conv.title || "Untitled Chat",
      });

      // Delete action button
      const itemActions = itemEl.createDiv({ cls: "ai-drawer-item-actions" });

      // Delete conversation button
      const deleteBtn = itemActions.createEl("button", {
        cls: "ai-drawer-action-btn delete",
        attr: { title: "Delete conversation" },
      });
      setIcon(deleteBtn, "trash-2");
      deleteBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        void this.handleDeleteConversation(conv.id);
      });

      itemEl.addEventListener("click", () => {
        void this.switchConversation(conv.id);
        if (this.rootEl.clientWidth < 400) {
          this.toggleDrawer(false);
        }
      });
    }
  }

  private toggleDrawer(forceState?: boolean): void {
    this.isDrawerOpen = forceState !== undefined ? forceState : !this.isDrawerOpen;
    if (this.isDrawerOpen) {
      this.drawerEl.removeClass("collapsed");
      this.drawerEl.addClass("open");
    } else {
      this.drawerEl.removeClass("open");
      this.drawerEl.addClass("collapsed");
    }
  }

  private async handleNewChat(): Promise<void> {
    this.currentConversationId = `conv_${Date.now()}`;
    this.messages = [this.createDefaultGreetingMessage()];
    this.plugin.activeConversationId = "";
    this.attachedMentions = [];
    this.renderAttachedMentionsBar();
    this.closeMentionPopup();
    await this.plugin.saveSettings();

    this.updateDrawerList();
    await this.renderMessages();
    this.toggleDrawer(false);
    new Notice("Started a new conversation.");
  }

  private async switchConversation(id: string): Promise<void> {
    if (this.currentConversationId === id) return;
    const found = this.plugin.conversations.find((c) => c.id === id);
    if (!found) return;

    this.currentConversationId = found.id;
    this.messages = [...found.messages];
    this.plugin.activeConversationId = found.id;
    this.attachedMentions = [];
    this.renderAttachedMentionsBar();
    this.closeMentionPopup();
    await this.plugin.saveSettings();

    this.updateDrawerList();
    await this.renderMessages();
    this.scrollToBottom();
  }

  private async handleDeleteConversation(id: string): Promise<void> {
    this.plugin.conversations = (this.plugin.conversations || []).filter(
      (c) => c.id !== id
    );

    if (this.currentConversationId === id) {
      const validConvs = this.plugin.conversations.filter(
        (c) => c.messages && c.messages.some((m) => m.role === "user")
      );

      if (validConvs.length > 0) {
        const next = validConvs[0];
        this.currentConversationId = next.id;
        this.messages = [...next.messages];
        this.plugin.activeConversationId = next.id;
      } else {
        this.currentConversationId = `conv_${Date.now()}`;
        this.messages = [this.createDefaultGreetingMessage()];
        this.plugin.activeConversationId = "";
      }
    }

    await this.plugin.saveSettings();
    this.updateDrawerList();
    await this.renderMessages();
    new Notice("Conversation deleted.");
  }

  private async saveActiveConversation(): Promise<void> {
    const hasUserMsg = this.messages.some((m) => m.role === "user");
    if (!hasUserMsg) {
      const existed = this.plugin.conversations.some(
        (c) => c.id === this.currentConversationId
      );
      if (existed) {
        this.plugin.conversations = this.plugin.conversations.filter(
          (c) => c.id !== this.currentConversationId
        );
        if (this.plugin.activeConversationId === this.currentConversationId) {
          this.plugin.activeConversationId = "";
        }
        await this.plugin.saveSettings();
        this.updateDrawerList();
      }
      return;
    }

    let conv = this.plugin.conversations.find(
      (c) => c.id === this.currentConversationId
    );

    if (!conv) {
      conv = {
        id: this.currentConversationId,
        title: "Chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      this.plugin.conversations.unshift(conv);
    }

    conv.messages = [...this.messages];
    conv.updatedAt = Date.now();

    // Auto-title from first user message
    const firstUser = this.messages.find((m) => m.role === "user");
    if (firstUser) {
      const clean = this.extractPromptAndContext(firstUser.content).prompt;
      conv.title = clean.slice(0, 36).trim() || "Chat";
    }

    this.plugin.activeConversationId = this.currentConversationId;
    await this.plugin.saveSettings();
    this.updateDrawerList();
  }

  // ==========================================
  // Main Chat Layout
  // ==========================================
  private renderMainContent(): void {
    this.mainChatEl = this.rootEl.createDiv({ cls: "ai-sidepanel-main" });

    this.renderHeader(this.mainChatEl);
    this.renderActiveNoteBar(this.mainChatEl);
    this.renderChatArea(this.mainChatEl);
    this.renderInputArea(this.mainChatEl);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "ai-sidepanel-header" });

    const leftBox = header.createDiv({ cls: "ai-sidepanel-left-box" });

    // Drawer toggle button (History)
    const historyBtn = leftBox.createEl("button", {
      cls: "clickable-icon ai-history-toggle-btn",
      attr: { title: "Conversation History" },
    });
    setIcon(historyBtn, "panel-left");
    historyBtn.addEventListener("click", () => this.toggleDrawer());

    // Title
    const titleBox = leftBox.createDiv({ cls: "ai-sidepanel-title-box" });
    const iconSpan = titleBox.createSpan({ cls: "ai-sidepanel-header-icon" });
    setIcon(iconSpan, "sparkles");
    titleBox.createSpan({ text: "Assistant Panel", cls: "ai-sidepanel-title" });

    // Actions Box (Right)
    const actionsBox = header.createDiv({ cls: "ai-sidepanel-header-actions" });

    // New Chat button
    const newChatBtn = actionsBox.createEl("button", {
      cls: "clickable-icon",
      attr: { title: "New Conversation" },
    });
    setIcon(newChatBtn, "plus");
    newChatBtn.addEventListener("click", () => {
      void this.handleNewChat();
    });

    // Delete current conversation button
    const deleteConvBtn = actionsBox.createEl("button", {
      cls: "clickable-icon",
      attr: { title: "Delete this conversation" },
    });
    setIcon(deleteConvBtn, "trash-2");
    deleteConvBtn.addEventListener("click", () => {
      void this.handleDeleteConversation(this.currentConversationId);
    });

    // Settings shortcut button
    const settingsBtn = actionsBox.createEl("button", {
      cls: "clickable-icon",
      attr: { title: "Open Settings" },
    });
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => {
      const settingApi = (this.app as unknown as AppWithSettings).setting;
      settingApi?.open?.();
      settingApi?.openTabById?.(this.plugin.manifest.id);
    });
  }

  public refreshFromSettings(): void {
    this.aiClient.updateSettings(this.plugin.settings);
    this.updateModelPill();
  }

  private updateModelPill(): void {
    if (!this.modelPillEl) return;
    const model = this.plugin.settings.model || "Select Model";
    const synced = getSyncedAttachedModels(this.plugin.settings);
    this.modelPillEl.empty();
    const iconSpan = this.modelPillEl.createSpan({ cls: "ai-model-pill-icon" });
    setIcon(iconSpan, "sparkles");
    this.modelPillEl.createSpan({ text: model, cls: "ai-model-pill-text" });
    const chevronSpan = this.modelPillEl.createSpan({ cls: "ai-model-pill-chevron" });
    setIcon(chevronSpan, "chevron-down");

    const endpointLabel = getProviderLabelFromBaseUrl(this.plugin.settings.baseUrl);
    const multiNote =
      synced.length > 1 ? ` • ${synced.length} models attached` : "";
    this.modelPillEl.setAttribute(
      "title",
      `Active Model: ${model} (${endpointLabel}${multiNote}) - Click to switch`
    );
    this.updateReasoningPill();
  }

  private updateReasoningPill(): void {
    if (!this.reasoningPillEl) return;
    const cap = getActiveModelReasoningCapability(this.plugin.settings);
    if (!cap.supported) {
      this.reasoningPillEl.addClass("hidden");
      this.closeReasoningPopup();
      return;
    }

    this.reasoningPillEl.removeClass("hidden");
    const currentEffort: ReasoningEffort =
      this.plugin.settings.reasoningEffort || "medium";
    const effectiveEffort = cap.efforts.includes(currentEffort)
      ? currentEffort
      : cap.efforts[cap.efforts.length - 1] || "high";
    const meta =
      REASONING_EFFORT_OPTIONS.find((o) => o.value === effectiveEffort) ||
      REASONING_EFFORT_OPTIONS[1];

    this.reasoningPillEl.empty();
    const brainSpan = this.reasoningPillEl.createSpan({
      cls: "ai-reasoning-pill-icon",
    });
    setIcon(brainSpan, "brain");
    this.reasoningPillEl.createSpan({
      text: meta.shortLabel,
      cls: "ai-reasoning-pill-text",
    });
    const chevSpan = this.reasoningPillEl.createSpan({
      cls: "ai-model-pill-chevron",
    });
    setIcon(chevSpan, "chevron-down");
    this.reasoningPillEl.setAttribute(
      "title",
      `Reasoning Level: ${meta.label} (${meta.description}) — Click to change`
    );
  }

  private renderActiveNoteBar(container: HTMLElement): void {
    this.activeNoteBadgeEl = container.createDiv({ cls: "ai-sidepanel-active-note-bar" });
    this.updateActiveNoteBar();
  }

  private updateActiveNoteBar(): void {
    if (!this.activeNoteBadgeEl) return;
    this.activeNoteBadgeEl.empty();

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.activeNoteBadgeEl.addClass("hidden");
      return;
    }

    this.activeNoteBadgeEl.removeClass("hidden");
    const barWrapper = this.activeNoteBadgeEl.createDiv({ cls: "ai-context-bar-inner" });

    barWrapper.createSpan({ cls: "ai-context-label", text: "Active Note: " });

    const chip = barWrapper.createDiv({
      cls: `ai-note-chip ${this.attachActiveNote ? "active" : "inactive"}`,
    });

    const iconSpan = chip.createSpan({ cls: "ai-chip-icon" });
    setIcon(iconSpan, "file-text");

    chip.createSpan({
      text: activeFile.basename,
      cls: "ai-chip-title",
    });

    chip.createSpan({
      cls: "ai-chip-toggle",
      text: this.attachActiveNote ? "(Attached)" : "(Click to attach)",
    });

    chip.addEventListener("click", () => {
      this.attachActiveNote = !this.attachActiveNote;
      this.updateActiveNoteBar();
      new Notice(
        this.attachActiveNote
          ? `Attached [[${activeFile.basename}]] to context.`
          : `Detached [[${activeFile.basename}]] from context.`
      );
    });
  }

  private renderChatArea(container: HTMLElement): void {
    this.chatContainerEl = container.createDiv({ cls: "ai-sidepanel-chat-container" });
    this.statusEl = container.createDiv({ cls: "ai-sidepanel-status-bar hidden" });
  }

  private renderInputArea(container: HTMLElement): void {
    this.inputWrapperEl = container.createDiv({ cls: "ai-sidepanel-input-wrapper" });

    // Compact chips row showing explicitly @-mentioned notes & folders attached to next message
    this.mentionBarEl = this.inputWrapperEl.createDiv({
      cls: "ai-mentioned-chips-bar hidden",
    });

    this.inputEl = this.inputWrapperEl.createEl("textarea", {
      cls: "ai-sidepanel-textarea",
      attr: {
        placeholder:
          "Ask about your vault, or type @ or [[ to mention notes/folders... (Shift+Enter for newline)",
        rows: "2",
      },
    });

    this.inputEl.addEventListener("input", () => {
      this.inputEl.setCssStyles({ height: "auto" });
      this.inputEl.setCssStyles({
        height: `${Math.min(this.inputEl.scrollHeight, 180)}px`,
      });
      this.syncInlineMentionPopup();
    });

    this.inputEl.addEventListener("click", () => {
      this.syncInlineMentionPopup();
    });

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      // Handle keyboard navigation when inline @ or [[ mention popup is open
      if (this.isMentionPopupOpen && this.mentionTriggerMode === "inline") {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (this.mentionMatches.length > 0) {
            this.mentionActiveIdx =
              (this.mentionActiveIdx + 1) % this.mentionMatches.length;
            this.renderMentionPopupResults();
          }
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (this.mentionMatches.length > 0) {
            this.mentionActiveIdx =
              (this.mentionActiveIdx - 1 + this.mentionMatches.length) %
              this.mentionMatches.length;
            this.renderMentionPopupResults();
          }
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (this.mentionMatches.length > 0) {
            e.preventDefault();
            this.selectMentionCandidate(
              this.mentionMatches[this.mentionActiveIdx] || this.mentionMatches[0]
            );
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeMentionPopup();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.handleSend();
      }
    });

    const controlsRow = this.inputWrapperEl.createDiv({
      cls: "ai-sidepanel-input-controls",
    });

    // Left controls: @ Note mention button + Model Name Pill
    const leftControls = controlsRow.createDiv({ cls: "ai-input-left-group" });
    this.mentionBtnEl = leftControls.createEl("button", {
      cls: "ai-input-btn",
      text: "@ Note",
      attr: { title: "Search & attach a note or folder (or type @ or [[)" },
    });
    this.mentionBtnEl.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      if (this.isMentionPopupOpen && this.mentionTriggerMode === "button") {
        this.closeMentionPopup();
        return;
      }
      const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
      const selEnd = this.inputEl.selectionEnd ?? cursor;
      this.openMentionPopup("button", "", cursor, selEnd);
    });

    // Model Name highlighted underneath the text box (interactive model switcher)
    this.modelPillEl = leftControls.createDiv({
      cls: "ai-sidepanel-model-pill",
      attr: { role: "button", tabindex: "0" },
    });
    this.updateModelPill();
    this.modelPillEl.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      this.toggleModelPopup();
    });
    this.modelPillEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.toggleModelPopup();
      }
    });

    // Reasoning Effort Pill (visible automatically when active model supports thinking/reasoning)
    this.reasoningPillEl = leftControls.createDiv({
      cls: "ai-sidepanel-reasoning-pill hidden",
      attr: { role: "button", tabindex: "0" },
    });
    this.updateReasoningPill();
    this.reasoningPillEl.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      this.toggleReasoningPopup();
    });
    this.reasoningPillEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.toggleReasoningPopup();
      }
    });

    // Right controls: Send / Stop Button
    const rightControls = controlsRow.createDiv({ cls: "ai-input-right-group" });

    // Send / Stop button
    this.sendBtnEl = rightControls.createEl("button", {
      cls: "mod-cta ai-send-btn",
      text: "Send",
    });
    this.sendBtnEl.addEventListener("click", () => {
      if (this.isGenerating) {
        this.handleStop();
      } else {
        void this.handleSend();
      }
    });
  }

  // ==========================================
  // @ Note / [[ Mention Picker & Context Chips
  // ==========================================
  private renderAttachedMentionsBar(): void {
    if (!this.mentionBarEl) return;
    this.mentionBarEl.empty();

    if (this.attachedMentions.length === 0) {
      this.mentionBarEl.addClass("hidden");
      return;
    }

    this.mentionBarEl.removeClass("hidden");
    this.mentionBarEl.createSpan({
      cls: "ai-mentioned-bar-label",
      text: "Context:",
    });

    this.attachedMentions.forEach((item, idx) => {
      const chip = this.mentionBarEl.createDiv({ cls: "ai-mentioned-chip" });
      const iconSpan = chip.createSpan({ cls: "ai-mentioned-chip-icon" });
      setIcon(iconSpan, item.kind === "folder" ? "folder" : "file-text");
      chip.createSpan({
        cls: "ai-mentioned-chip-text",
        text: item.label,
        attr: { title: `${item.path} (Full context will be sent with prompt)` },
      });

      const removeBtn = chip.createEl("button", {
        cls: "ai-mentioned-chip-remove",
        attr: { title: "Detach from prompt context" },
      });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        this.attachedMentions.splice(idx, 1);
        this.renderAttachedMentionsBar();
      });
    });
  }

  private collectMentionCandidates(query: string): MentionCandidate[] {
    const q = (query || "").trim().toLowerCase();
    const candidates: MentionCandidate[] = [];

    // Collect Markdown notes
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      const folderPart = f.parent && !f.parent.isRoot() ? `${f.parent.path}/` : "Vault Root";
      candidates.push({
        kind: "note",
        title: f.basename,
        path: f.path,
        subtitle: folderPart,
        mtime: f.stat?.mtime || 0,
        file: f,
      });
    }

    // Collect Folders (excluding root)
    const walkFolders = (dir: TFolder) => {
      for (const child of dir.children) {
        if (child instanceof TFolder) {
          candidates.push({
            kind: "folder",
            title: child.name,
            path: child.path,
            subtitle: `${child.children.length} item(s)`,
            mtime: 0,
            folder: child,
          });
          walkFolders(child);
        }
      }
    };
    walkFolders(this.app.vault.getRoot());

    if (!q) {
      // Sort recently modified notes first, then folders alphabetically
      return candidates
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "note" ? -1 : 1;
          if (a.mtime !== b.mtime) return b.mtime - a.mtime;
          return a.title.localeCompare(b.title);
        })
        .slice(0, 25);
    }

    // Ranked fuzzy/substring filtering
    const scored: Array<{ c: MentionCandidate; score: number }> = [];
    for (const c of candidates) {
      const titleLower = c.title.toLowerCase();
      const pathLower = c.path.toLowerCase();
      if (titleLower === q) {
        scored.push({ c, score: 0 });
      } else if (titleLower.startsWith(q)) {
        scored.push({ c, score: 1 });
      } else if (titleLower.includes(q)) {
        scored.push({ c, score: 2 });
      } else if (pathLower.includes(q)) {
        scored.push({ c, score: 3 });
      }
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.c.kind !== b.c.kind) return a.c.kind === "note" ? -1 : 1;
      return b.c.mtime - a.c.mtime || a.c.title.localeCompare(b.c.title);
    });

    return scored.slice(0, 25).map((s) => s.c);
  }

  private detectInlineMentionTrigger(
    text: string,
    cursor: number
  ): { query: string; start: number; end: number } | null {
    const beforeCursor = text.slice(0, cursor);
    const lastNewline = beforeCursor.lastIndexOf("\n");
    const lineStart = lastNewline + 1;
    const lineSegment = beforeCursor.slice(lineStart);

    // 1. Check [[query
    const openBracketIdx = lineSegment.lastIndexOf("[[");
    if (openBracketIdx !== -1) {
      const afterBracket = lineSegment.slice(openBracketIdx + 2);
      if (!afterBracket.includes("]]")) {
        return {
          query: afterBracket,
          start: lineStart + openBracketIdx,
          end: cursor,
        };
      }
    }

    // 2. Check @query (only at start of line or right after whitespace so emails don't trigger)
    const atMatch = lineSegment.match(/(?:^|\s)@([^\n[\]]*)$/);
    if (atMatch) {
      const query = atMatch[1];
      if (query.length <= 45) {
        const atIndexInSegment = lineSegment.length - query.length - 1;
        return {
          query,
          start: lineStart + atIndexInSegment,
          end: cursor,
        };
      }
    }

    return null;
  }

  private syncInlineMentionPopup(): void {
    if (!this.inputEl) return;
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const trigger = this.detectInlineMentionTrigger(this.inputEl.value, cursor);

    if (trigger) {
      const candidates = this.collectMentionCandidates(trigger.query);
      // Avoid sticking open if user typed normal prose after @ with multiple spaces and 0 matches
      if (
        trigger.query.length > 0 &&
        candidates.length === 0 &&
        trigger.query.split(" ").length >= 3
      ) {
        if (this.mentionTriggerMode === "inline") {
          this.closeMentionPopup();
        }
        return;
      }

      if (!this.isMentionPopupOpen || this.mentionTriggerMode !== "inline") {
        this.openMentionPopup("inline", trigger.query, trigger.start, trigger.end);
      } else {
        this.mentionReplaceStart = trigger.start;
        this.mentionReplaceEnd = trigger.end;
        this.mentionMatches = candidates;
        this.mentionActiveIdx = 0;
        this.renderMentionPopupResults();
      }
    } else if (this.isMentionPopupOpen && this.mentionTriggerMode === "inline") {
      this.closeMentionPopup();
    }
  }

  private closeMentionPopup(): void {
    if (this.mentionPopupEl) {
      this.mentionPopupEl.remove();
      this.mentionPopupEl = null;
    }
    this.mentionSearchInputEl = null;
    this.mentionResultsEl = null;
    this.isMentionPopupOpen = false;
  }

  private openMentionPopup(
    mode: "button" | "inline",
    initialQuery: string,
    replaceStart: number,
    replaceEnd: number
  ): void {
    this.closeModelPopup();
    this.closeReasoningPopup();
    this.closeMentionPopup();

    this.isMentionPopupOpen = true;
    this.mentionTriggerMode = mode;
    this.mentionReplaceStart = replaceStart;
    this.mentionReplaceEnd = replaceEnd;
    this.mentionMatches = this.collectMentionCandidates(initialQuery);
    this.mentionActiveIdx = 0;

    if (!this.inputWrapperEl) return;

    this.mentionPopupEl = this.inputWrapperEl.createDiv({
      cls: "ai-mention-popup-card",
    });

    // Header bar
    const header = this.mentionPopupEl.createDiv({ cls: "ai-mention-popup-header" });
    const titleWrap = header.createDiv({ cls: "ai-mention-popup-title-wrap" });
    const iconEl = titleWrap.createSpan({ cls: "ai-mention-popup-icon" });
    setIcon(iconEl, "at-sign");
    titleWrap.createSpan({
      text:
        mode === "inline"
          ? "Mention Note or Folder (↑↓ Enter)"
          : "Mention & Attach Note or Folder",
    });

    const closeBtn = header.createEl("button", {
      cls: "clickable-icon ai-popup-close-btn",
      attr: { title: "Close" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => {
      this.closeMentionPopup();
      this.inputEl.focus();
    });

    // Search input when opened via @ Note button
    if (mode === "button") {
      const searchWrap = this.mentionPopupEl.createDiv({
        cls: "ai-mention-search-wrap",
      });
      this.mentionSearchInputEl = searchWrap.createEl("input", {
        type: "text",
        cls: "ai-mention-search-input",
        placeholder: "Search notes or folders by name/path...",
        value: initialQuery,
      });

      this.mentionSearchInputEl.addEventListener("input", () => {
        const q = this.mentionSearchInputEl?.value || "";
        this.mentionMatches = this.collectMentionCandidates(q);
        this.mentionActiveIdx = 0;
        this.renderMentionPopupResults();
      });

      this.mentionSearchInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (this.mentionMatches.length > 0) {
            this.mentionActiveIdx =
              (this.mentionActiveIdx + 1) % this.mentionMatches.length;
            this.renderMentionPopupResults();
          }
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (this.mentionMatches.length > 0) {
            this.mentionActiveIdx =
              (this.mentionActiveIdx - 1 + this.mentionMatches.length) %
              this.mentionMatches.length;
            this.renderMentionPopupResults();
          }
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (this.mentionMatches.length > 0) {
            this.selectMentionCandidate(
              this.mentionMatches[this.mentionActiveIdx] || this.mentionMatches[0]
            );
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.closeMentionPopup();
          this.inputEl.focus();
        }
      });
    }

    this.mentionResultsEl = this.mentionPopupEl.createDiv({
      cls: "ai-mention-results-list",
    });
    this.renderMentionPopupResults();

    if (this.mentionSearchInputEl) {
      window.setTimeout(() => this.mentionSearchInputEl?.focus(), 10);
    }
  }

  private renderMentionPopupResults(): void {
    if (!this.mentionResultsEl) return;
    this.mentionResultsEl.empty();

    if (this.mentionMatches.length === 0) {
      this.mentionResultsEl.createDiv({
        cls: "ai-mention-empty",
        text: "No matching notes or folders found.",
      });
      return;
    }

    this.mentionMatches.forEach((candidate, idx) => {
      const isActive = idx === this.mentionActiveIdx;
      const row = this.mentionResultsEl!.createDiv({
        cls: `ai-mention-item ${isActive ? "active" : ""}`,
      });

      const iconSpan = row.createSpan({ cls: "ai-mention-item-icon" });
      setIcon(iconSpan, candidate.kind === "folder" ? "folder" : "file-text");

      const textCol = row.createDiv({ cls: "ai-mention-item-text" });
      textCol.createDiv({
        cls: "ai-mention-item-title",
        text: candidate.title,
      });
      textCol.createDiv({
        cls: "ai-mention-item-sub",
        text: candidate.subtitle,
      });

      row.createSpan({
        cls: `ai-mention-kind-tag ${candidate.kind}`,
        text: candidate.kind === "folder" ? "Folder" : "Note",
      });

      row.addEventListener("mouseenter", () => {
        this.mentionActiveIdx = idx;
        const rows = this.mentionResultsEl?.querySelectorAll(".ai-mention-item");
        rows?.forEach((el, rIdx) => {
          el.toggleClass("active", rIdx === idx);
        });
      });

      row.addEventListener("mousedown", (e: MouseEvent) => {
        e.preventDefault(); // Prevent textarea blur before selection completes
      });

      row.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        this.selectMentionCandidate(candidate);
      });

      if (isActive) {
        row.scrollIntoView({ block: "nearest" });
      }
    });
  }

  private selectMentionCandidate(candidate: MentionCandidate): void {
    const val = this.inputEl.value;
    const start = Math.max(0, Math.min(this.mentionReplaceStart, val.length));
    const end = Math.max(start, Math.min(this.mentionReplaceEnd, val.length));

    let linkText: string;
    if (candidate.kind === "folder") {
      linkText = `[[${candidate.path}/]] `;
    } else {
      // Use unambiguous full path (without .md) if duplicate note names exist in vault
      const duplicates = this.app.vault
        .getMarkdownFiles()
        .filter((f) => f.basename.toLowerCase() === candidate.title.toLowerCase());
      const refTarget =
        duplicates.length > 1
          ? candidate.path.replace(/\.md$/i, "")
          : candidate.title;
      linkText = `[[${refTarget}]] `;
    }

    const updated = val.slice(0, start) + linkText + val.slice(end);
    this.inputEl.value = updated;
    const newCursor = start + linkText.length;
    this.inputEl.setCssStyles({ height: "auto" });
    this.inputEl.setCssStyles({
      height: `${Math.min(this.inputEl.scrollHeight, 180)}px`,
    });

    // Add to attached mentions list (deduplicated) for automatic context injection on Send
    const alreadyAttached = this.attachedMentions.some(
      (m) => m.kind === candidate.kind && m.path === candidate.path
    );
    if (!alreadyAttached) {
      this.attachedMentions.push({
        kind: candidate.kind,
        path: candidate.path,
        label: candidate.kind === "folder" ? `${candidate.path}/` : candidate.title,
      });
      this.renderAttachedMentionsBar();
    }

    this.closeMentionPopup();
    this.inputEl.focus();
    this.inputEl.setSelectionRange(newCursor, newCursor);
  }

  private extractPromptAndContext(rawContent: string): {
    contextLabel: string | null;
    prompt: string;
  } {
    const sep = "\n===USER_PROMPT===\n";
    const sepIdx = rawContent.indexOf(sep);
    if (sepIdx !== -1) {
      const headerBlock = rawContent.slice(0, sepIdx);
      const firstLine = headerBlock.split("\n")[0] || "";
      const labelMatch = firstLine.match(/^\[Context:\s*(.+)\]$/);
      return {
        contextLabel: labelMatch ? labelMatch[1] : "Attached vault context",
        prompt: rawContent.slice(sepIdx + sep.length),
      };
    }

    // Legacy active-note context fallback
    if (rawContent.startsWith("[Context: Active Note")) {
      const parts = rawContent.split("---\n\n");
      if (parts.length > 1) {
        return {
          contextLabel: "Attached active note",
          prompt: parts.slice(1).join("---\n\n"),
        };
      }
    }

    return { contextLabel: null, prompt: rawContent };
  }

  // ==========================================
  // Reasoning Effort Floating Picker
  // ==========================================
  private toggleReasoningPopup(): void {
    if (this.isReasoningPopupOpen) {
      this.closeReasoningPopup();
    } else {
      this.openReasoningPopup();
    }
  }

  private closeReasoningPopup(): void {
    if (this.reasoningPopupEl) {
      this.reasoningPopupEl.remove();
      this.reasoningPopupEl = null;
    }
    this.isReasoningPopupOpen = false;
  }

  private openReasoningPopup(): void {
    const cap = getActiveModelReasoningCapability(this.plugin.settings);
    if (!cap.supported) return;

    this.closeMentionPopup();
    this.closeModelPopup();
    this.closeReasoningPopup();
    this.isReasoningPopupOpen = true;

    const inputWrapper = this.mainChatEl.querySelector(
      ".ai-sidepanel-input-wrapper"
    ) as HTMLElement;
    if (!inputWrapper) return;

    this.reasoningPopupEl = inputWrapper.createDiv({
      cls: "ai-reasoning-popup-card",
    });

    const header = this.reasoningPopupEl.createDiv({
      cls: "ai-reasoning-popup-header",
    });
    const brainIcon = header.createSpan({ cls: "ai-reasoning-popup-icon" });
    setIcon(brainIcon, "brain");
    header.createSpan({
      text: "Reasoning Level",
      cls: "ai-reasoning-popup-title",
    });

    const currentEffort: ReasoningEffort =
      this.plugin.settings.reasoningEffort || "medium";
    const list = this.reasoningPopupEl.createDiv({
      cls: "ai-reasoning-popup-list",
    });

    for (const opt of REASONING_EFFORT_OPTIONS) {
      if (!cap.efforts.includes(opt.value)) continue;
      const isSelected = currentEffort === opt.value;
      const item = list.createDiv({
        cls: `ai-reasoning-option ${isSelected ? "selected" : ""}`,
      });

      const leftCol = item.createDiv({ cls: "ai-reasoning-option-main" });
      leftCol.createSpan({
        text: opt.label,
        cls: "ai-reasoning-option-label",
      });
      leftCol.createSpan({
        text: opt.description,
        cls: "ai-reasoning-option-desc",
      });

      if (isSelected) {
        const check = item.createSpan({ cls: "ai-model-check" });
        setIcon(check, "check");
      }

      item.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        void (async () => {
          this.plugin.settings.reasoningEffort = opt.value;
          await this.plugin.saveSettings();
          this.closeReasoningPopup();
          this.updateReasoningPill();
          new Notice(`Reasoning effort set to: ${opt.label}`);
        })();
      });
    }
  }

  // ==========================================
  // AI Model Floating Card Popup
  // ==========================================
  private toggleModelPopup(): void {
    if (this.isModelPopupOpen) {
      this.closeModelPopup();
    } else {
      this.openModelPopup();
    }
  }

  private closeModelPopup(): void {
    if (this.popupCardEl) {
      this.popupCardEl.remove();
      this.popupCardEl = null;
    }
    this.isModelPopupOpen = false;
  }

  private openModelPopup(): void {
    this.closeMentionPopup();
    this.closeReasoningPopup();
    this.closeModelPopup();
    this.isModelPopupOpen = true;

    const inputWrapper = this.mainChatEl.querySelector(
      ".ai-sidepanel-input-wrapper"
    ) as HTMLElement;
    if (!inputWrapper) return;

    this.popupCardEl = inputWrapper.createDiv({ cls: "ai-model-popup-card" });

    // Card Header
    const cardHeader = this.popupCardEl.createDiv({ cls: "ai-popup-header" });
    const headerTitle = cardHeader.createDiv({ cls: "ai-popup-title-box" });
    const botIcon = headerTitle.createSpan({ cls: "ai-popup-bot-icon" });
    setIcon(botIcon, "bot");
    headerTitle.createSpan({ text: "Connected AI Models", cls: "ai-popup-title" });

    const headerActions = cardHeader.createDiv({ cls: "ai-popup-header-actions" });
    const headerRescanBtn = headerActions.createEl("button", {
      cls: "clickable-icon ai-popup-rescan-btn",
      attr: { title: "Re-scan & Live Verify Models", type: "button" },
    });
    setIcon(headerRescanBtn, "refresh-cw");
    headerRescanBtn.addEventListener("click", () => {
      this.closeModelPopup();
      new ModelsPickerModal(
        this.app,
        this.plugin,
        () => this.updateModelPill(),
        { forceScan: true }
      ).open();
    });

    const closeBtn = headerActions.createEl("button", {
      cls: "clickable-icon ai-popup-close-btn",
      attr: { title: "Close", type: "button" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.closeModelPopup());

    const profiles = this.plugin.getProfiles();
    const activeProfile = this.plugin.getActiveProfile();
    let showAllProfiles = false;

    const getPopupState = () => {
      const attached = getSyncedAttachedModels(this.plugin.settings);
      const hasBaseUrl = Boolean(this.plugin.settings.baseUrl?.trim());
      const hasKeyOrLocal =
        Boolean(this.plugin.settings.apiKey?.trim()) ||
        isLocalBaseUrl(this.plugin.settings.baseUrl);
      const isConnected = hasBaseUrl && hasKeyOrLocal;

      const entries = showAllProfiles
        ? profiles.flatMap((p) =>
            (p.attachedModels || [])
              .filter((m) => m.isLive === true)
              .map((m) => ({
                profileId: p.id,
                profileName: p.name || getProviderLabelFromBaseUrl(p.baseUrl),
                baseUrl: p.baseUrl,
                model: {
                  ...m,
                  isLive: true,
                  category:
                    m.category || categorizeModel(m.id, m.name, m.description),
                },
              }))
          )
        : attached.map((m) => ({
            profileId: activeProfile?.id || "",
            profileName:
              activeProfile?.name ||
              getProviderLabelFromBaseUrl(this.plugin.settings.baseUrl),
            baseUrl: this.plugin.settings.baseUrl,
            model: m,
          }));

      return { attached, hasBaseUrl, hasKeyOrLocal, isConnected, entries };
    };

    // Connection Status + Endpoint Summary (compact 2-line card)
    const initialState = getPopupState();
    const statusSummaryBox = this.popupCardEl.createDiv({
      cls: "ai-popup-connection-summary",
    });
    const statusBox = statusSummaryBox.createDiv({ cls: "ai-popup-status-box" });
    const statusDotEl = statusBox.createSpan({ cls: "ai-popup-status-dot" });
    const statusTextEl = statusBox.createSpan({ cls: "ai-popup-status-text" });

    const urlInfoBox = statusSummaryBox.createDiv({ cls: "ai-popup-url-box" });
    urlInfoBox.createSpan({ cls: "ai-popup-url-label", text: "Endpoint:" });
    const urlValueEl = urlInfoBox.createSpan({ cls: "ai-popup-url-value" });

    const updateConnectionSummary = () => {
      const { attached, hasBaseUrl, hasKeyOrLocal, isConnected, entries } =
        getPopupState();
      const statusDotClass = showAllProfiles
        ? entries.length > 0
          ? "online"
          : "pending"
        : !isConnected
        ? "warning"
        : attached.length > 0
        ? "online"
        : "pending";
      statusDotEl.className = `ai-popup-status-dot ${statusDotClass}`;

      const endpointLabel = getProviderLabelFromBaseUrl(this.plugin.settings.baseUrl);
      const statusMessage = showAllProfiles
        ? `All Profiles • ${entries.length} Verified Model${entries.length === 1 ? "" : "s"}`
        : !hasBaseUrl
        ? "Base URL not configured (Set in Settings)"
        : !hasKeyOrLocal
        ? "No API key (Set in Settings)"
        : attached.length > 1
        ? `${endpointLabel} • ${attached.length} Models Verified`
        : attached.length === 1
        ? `${endpointLabel} • 1 Model Verified`
        : `${endpointLabel}: Ready (Scan to verify models)`;
      statusTextEl.setText(statusMessage);

      if (showAllProfiles) {
        urlInfoBox.addClass("hidden");
      } else {
        urlInfoBox.removeClass("hidden");
        const urlStr = this.plugin.settings.baseUrl || "Not set";
        urlValueEl.setText(urlStr);
        urlValueEl.setAttr("title", urlStr);
      }
    };

    // Profiles Switcher Bar (placed cleanly below summary when multiple profiles exist)
    if (profiles.length > 1) {
      const profilesBar = this.popupCardEl.createDiv({
        cls: "ai-popup-profiles-bar",
      });

      const allBtn = profilesBar.createEl("button", {
        cls: "ai-popup-profile-pill",
        text: "All Profiles",
        attr: {
          type: "button",
          title: "Show verified models across all saved API keys & endpoints",
        },
      });

      const profBtns: { id: string; el: HTMLButtonElement }[] = [];
      for (const prof of profiles) {
        const pBtn = profilesBar.createEl("button", {
          cls: `ai-popup-profile-pill ${
            prof.id === activeProfile?.id ? "active" : ""
          }`,
          text: prof.name || "Profile",
          attr: {
            type: "button",
            title: prof.baseUrl || "No Base URL configured",
          },
        });
        profBtns.push({ id: prof.id, el: pBtn });

        pBtn.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation();
          void (async () => {
            showAllProfiles = false;
            if (prof.id !== this.plugin.settings.activeProfileId) {
              await this.plugin.activateProfile(prof.id);
              this.closeModelPopup();
              this.openModelPopup();
            } else {
              allBtn.removeClass("active");
              pBtn.addClass("active");
              activeCategory = "all";
              refreshPopupCatalog();
            }
          })();
        });
      }

      allBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        showAllProfiles = true;
        allBtn.addClass("active");
        for (const item of profBtns) {
          item.el.removeClass("active");
        }
        activeCategory = "all";
        refreshPopupCatalog();
      });
    }

    // Models Section
    const modelsSection = this.popupCardEl.createDiv({ cls: "ai-popup-models-section" });
    const modelsHeader = modelsSection.createDiv({ cls: "ai-popup-models-header" });
    const modelsCountLabelEl = modelsHeader.createSpan({
      cls: "ai-popup-label",
      text: "Attached API Models",
    });

    let activeFilterQuery = "";
    let activeCategory: ModelCategory | "all" = "all";

    const filterInputEl = modelsSection.createEl("input", {
      type: "text",
      cls: "ai-popup-filter-input",
    });
    const catBarEl = modelsSection.createDiv({ cls: "ai-popup-cat-bar" });
    const modelsList = modelsSection.createDiv({ cls: "ai-popup-models-list" });

    const renderPopupCatChips = () => {
      const { entries } = getPopupState();
      const categoriesPresent = new Set<ModelCategory>(
        entries.map((entry) =>
          entry.model.category ||
          categorizeModel(entry.model.id, entry.model.name, entry.model.description)
        )
      );
      const orderedCats = MODEL_CATEGORY_ORDER.filter((c) => categoriesPresent.has(c));

      catBarEl.empty();
      if (orderedCats.length < 2) {
        catBarEl.addClass("hidden");
        activeCategory = "all";
        return;
      }
      catBarEl.removeClass("hidden");

      const addChip = (cat: ModelCategory | "all", label: string) => {
        const chip = catBarEl.createEl("button", {
          cls: `ai-popup-cat-chip ${activeCategory === cat ? "active" : ""}`,
          text: label,
          attr: { type: "button" },
        });
        chip.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation();
          activeCategory = cat;
          renderPopupCatChips();
          renderPopupModelCards();
        });
      };

      addChip("all", "All");
      for (const c of orderedCats) {
        addChip(c, MODEL_CATEGORY_META[c].shortLabel);
      }
    };

    const renderPopupModelCards = () => {
      modelsList.empty();
      const { hasBaseUrl, hasKeyOrLocal, entries } = getPopupState();

      if (entries.length === 0) {
        const emptyBox = modelsList.createDiv({ cls: "ai-popup-empty-box" });
        const emptyIcon = emptyBox.createSpan({ cls: "ai-popup-empty-icon" });
        setIcon(emptyIcon, "key");
        emptyBox.createDiv({
          cls: "ai-popup-empty-text",
          text: !hasBaseUrl
            ? "No Base URL configured in Settings."
            : !hasKeyOrLocal
            ? "No API key configured in Settings."
            : "No verified models for this Key & Base URL yet.",
        });

        const scanBtn = emptyBox.createEl("button", {
          cls: "mod-cta ai-popup-scan-action-btn",
          text: "⚡ Scan & Identify Models",
          attr: { type: "button" },
        });
        scanBtn.addEventListener("click", () => {
          this.closeModelPopup();
          new ModelsPickerModal(
            this.app,
            this.plugin,
            () => this.updateModelPill(),
            { forceScan: true }
          ).open();
        });
        return;
      }

      const q = activeFilterQuery.toLowerCase().trim();
      const filtered = entries.filter((entry) => {
        const m = entry.model;
        const cat = m.category || categorizeModel(m.id, m.name, m.description);
        if (activeCategory !== "all" && cat !== activeCategory) return false;
        if (!q) return true;
        return (
          m.id.toLowerCase().includes(q) ||
          (m.name && m.name.toLowerCase().includes(q)) ||
          entry.profileName.toLowerCase().includes(q) ||
          MODEL_CATEGORY_META[cat].label.toLowerCase().includes(q)
        );
      });

      if (filtered.length === 0) {
        modelsList.createDiv({
          cls: "ai-popup-empty-filter",
          text: "No verified models match your filter.",
        });
        return;
      }

      for (const entry of filtered) {
        const m = entry.model;
        const isSelected =
          this.plugin.settings.model === m.id &&
          (!entry.profileId ||
            entry.profileId === this.plugin.settings.activeProfileId);
        const cat = m.category || categorizeModel(m.id, m.name, m.description);
        const catMeta = MODEL_CATEGORY_META[cat];

        const modelCard = modelsList.createDiv({
          cls: `ai-model-card ${isSelected ? "selected" : ""}`,
        });

        const topRow = modelCard.createDiv({ cls: "ai-model-card-top" });
        topRow.createSpan({ text: m.name || m.id, cls: "ai-model-name" });
        if (isSelected) {
          const checkIcon = topRow.createSpan({
            cls: "ai-model-check",
            attr: { title: "Active model" },
          });
          setIcon(checkIcon, "check");
        }

        if (m.id !== m.name) {
          modelCard.createDiv({ cls: "ai-model-card-id-sub", text: m.id });
        }

        if (m.description) {
          modelCard.createDiv({ text: m.description, cls: "ai-model-desc" });
        }

        const tagsGroup = modelCard.createDiv({ cls: "ai-card-tags-group ai-popup-card-tags" });
        if (showAllProfiles && entry.profileName) {
          tagsGroup.createSpan({
            cls: "ai-popup-profile-tag",
            text: entry.profileName,
          });
        }
        const reasoningCap = detectReasoningCapability(m.id, m, entry.baseUrl);
        if (reasoningCap.supported) {
          const reasonTag = tagsGroup.createSpan({
            cls: "ai-popup-reasoning-tag",
            attr: { title: "Supports configurable reasoning levels" },
          });
          setIcon(reasonTag, "brain");
        }
        tagsGroup.createSpan({
          cls: `ai-popup-cat-tag cat-${cat}`,
          text: catMeta.shortLabel,
        });
        tagsGroup.createSpan({ cls: "ai-model-live-tag", text: "LIVE" });

        modelCard.addEventListener("click", () => {
          void (async () => {
            if (
              entry.profileId &&
              entry.profileId !== this.plugin.settings.activeProfileId
            ) {
              await this.plugin.activateProfile(entry.profileId, m.id);
              new Notice(
                `Switched to ${entry.profileName} • ${m.name || m.id}`
              );
            } else {
              this.plugin.settings.model = m.id;
              await this.plugin.saveSettings();
              new Notice(`Active Model set to: ${m.name || m.id}`);
            }
            this.closeModelPopup();
          })();
        });
      }
    };

    const refreshPopupCatalog = () => {
      const { entries } = getPopupState();
      updateConnectionSummary();
      modelsCountLabelEl.setText(
        entries.length > 0
          ? showAllProfiles
            ? `All Profile Models (${entries.length})`
            : `Verified Models (${entries.length})`
          : "Attached API Models"
      );

      if (entries.length >= 4) {
        filterInputEl.removeClass("hidden");
        filterInputEl.setAttr(
          "placeholder",
          `Quick filter ${entries.length} verified models...`
        );
      } else {
        filterInputEl.addClass("hidden");
        activeFilterQuery = "";
        filterInputEl.value = "";
      }

      renderPopupCatChips();
      renderPopupModelCards();
    };

    filterInputEl.addEventListener("input", () => {
      activeFilterQuery = filterInputEl.value;
      renderPopupModelCards();
    });

    refreshPopupCatalog();
    const attached = initialState.attached;

    // Popup Footer: Custom Model Verification + Full Explorer
    const popupFooter = this.popupCardEl.createDiv({ cls: "ai-popup-footer" });
    const customRow = popupFooter.createDiv({ cls: "ai-popup-custom-row" });
    const customInput = customRow.createEl("input", {
      type: "text",
      cls: "ai-popup-custom-input",
      value: this.plugin.settings.model,
      attr: { placeholder: "Test & attach custom model ID..." },
    });

    const setBtn = customRow.createEl("button", {
      cls: "ai-popup-set-btn",
      text: "Test & Use",
      attr: { type: "button" },
    });

    const handlePopupCustomTest = async () => {
      const val = customInput.value.trim();
      if (!val) return;
      const orig = setBtn.textContent || "Test & Use";
      setBtn.textContent = "Testing...";
      setBtn.setAttr("disabled", "true");

      const check = await verifySingleCustomModel(this.plugin.settings, val);

      setBtn.removeAttribute("disabled");
      setBtn.textContent = orig;

      if (check.ok && check.item) {
        await this.plugin.registerVerifiedModel(check.item, true);
        this.closeModelPopup();
        new Notice(`Verified & active model set to: ${check.item.id}`);
      } else {
        new Notice(
          `Model "${val}" rejected by key: ${check.error || "Unauthorized"}`,
          6000
        );
      }
    };

    setBtn.addEventListener("click", () => {
      void handlePopupCustomTest();
    });
    customInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handlePopupCustomTest();
      }
    });

    // View Full Model Explorer Button
    const browseAllBtn = popupFooter.createEl("button", {
      cls: "ai-popup-browse-all-btn",
      attr: { type: "button" },
      text:
        attached.length > 1
          ? `⚡ Explore All ${attached.length} Models by Family`
          : "⚡ Verify & Browse Callable Models",
    });
    browseAllBtn.addEventListener("click", () => {
      this.closeModelPopup();
      new ModelsPickerModal(this.app, this.plugin, () => {
        this.updateModelPill();
      }).open();
    });
  }

  // ==========================================
  // Chat Execution
  // ==========================================
  private setStatus(statusText: string | null): void {
    if (!statusText) {
      this.statusEl.addClass("hidden");
      this.statusEl.empty();
    } else {
      this.statusEl.removeClass("hidden");
      this.statusEl.empty();
      const spinner = this.statusEl.createSpan({ cls: "ai-status-spinner" });
      setIcon(spinner, "loader");
      this.statusEl.createSpan({ text: statusText, cls: "ai-status-text" });
    }
  }

  private handleStop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.setGenerating(false);
    this.setStatus(null);
  }

  private setGenerating(generating: boolean): void {
    this.isGenerating = generating;
    if (generating) {
      this.sendBtnEl.setText("Stop");
      this.sendBtnEl.addClass("mod-warning");
      this.sendBtnEl.removeClass("mod-cta");
    } else {
      this.sendBtnEl.setText("Send");
      this.sendBtnEl.removeClass("mod-warning");
      this.sendBtnEl.addClass("mod-cta");
    }
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isGenerating) return;

    if (!this.plugin.settings.baseUrl?.trim()) {
      new Notice("⚠️ Please enter your Base URL in the Assistant Panel settings first!");
      return;
    }

    if (!this.plugin.settings.apiKey?.trim() && !isLocalBaseUrl(this.plugin.settings.baseUrl)) {
      new Notice("⚠️ Please enter your API Key in the Assistant Panel settings first!");
      return;
    }

    this.closeMentionPopup();
    this.inputEl.value = "";
    this.inputEl.setCssStyles({ height: "auto" });

    const pendingMentions = [...this.attachedMentions];
    this.attachedMentions = [];
    this.renderAttachedMentionsBar();

    const finalPrompt = await this.buildPromptWithContext(text, pendingMentions);

    this.messages.push({
      role: "user",
      content: finalPrompt,
      timestamp: Date.now(),
    });

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    this.messages.push(assistantMsg);
    this.liveAssistantMsg = assistantMsg;

    await this.renderMessages();
    this.scrollToBottom();

    this.setGenerating(true);
    this.setStatus("Thinking...");
    this.abortController = new AbortController();

    this.aiClient.updateSettings(this.plugin.settings);

    const lastBubble = this.chatContainerEl.lastElementChild;
    const assistantActivityHost = lastBubble?.querySelector(
      ".ai-activity-host"
    ) as HTMLElement | null;
    const assistantMessageDiv = lastBubble?.querySelector(
      ".ai-message-content"
    ) as HTMLElement | null;

    let streamDone = false;
    let isRenderingChunk = false;
    let renderRequested = false;
    let rafScheduled = false;
    let activityRafScheduled = false;

    const scheduleActivityRender = (): void => {
      if (!assistantActivityHost || streamDone || activityRafScheduled) return;
      activityRafScheduled = true;
      window.requestAnimationFrame(() => {
        activityRafScheduled = false;
        if (streamDone || !assistantActivityHost) return;
        this.renderAssistantActivityDropdown(
          assistantActivityHost,
          assistantMsg,
          true
        );
        this.scrollToBottom();
      });
    };

    const flushStreamRender = async (): Promise<void> => {
      rafScheduled = false;
      if (!assistantMessageDiv || isRenderingChunk || streamDone) return;
      isRenderingChunk = true;
      try {
        while (renderRequested && !streamDone) {
          renderRequested = false;
          const snapshot = assistantMsg.content;
          const tempDiv = createDiv();
          await MarkdownRenderer.render(
            this.app,
            snapshot || "*(Thinking...)*",
            tempDiv,
            "",
            this
          );
          if (streamDone) break;
          this.wrapTablesInContainer(tempDiv);
          assistantMessageDiv.empty();
          while (tempDiv.firstChild) {
            assistantMessageDiv.appendChild(tempDiv.firstChild);
          }
          this.scrollToBottom();
        }
      } finally {
        isRenderingChunk = false;
      }
    };

    const scheduleStreamRender = (): void => {
      renderRequested = true;
      if (!isRenderingChunk && !rafScheduled && !streamDone) {
        rafScheduled = true;
        window.requestAnimationFrame(() => {
          void flushStreamRender();
        });
      }
    };

    try {
      const finalResponse = await this.aiClient.chat(this.messages.slice(0, -1), {
        onChunk: (chunk: string) => {
          assistantMsg.content += chunk;
          scheduleStreamRender();
        },
        onReasoningChunk: (chunk: string) => {
          assistantMsg.reasoningContent =
            (assistantMsg.reasoningContent || "") + chunk;
          scheduleActivityRender();
        },
        onToolActivity: (activity: ToolActivityRecord) => {
          if (!assistantMsg.toolActivities) {
            assistantMsg.toolActivities = [];
          }
          const idx = assistantMsg.toolActivities.findIndex(
            (item) => item.id === activity.id
          );
          if (idx >= 0) {
            assistantMsg.toolActivities[idx] = activity;
          } else {
            assistantMsg.toolActivities.push(activity);
          }
          scheduleActivityRender();
        },
        onReset: () => {
          assistantMsg.content = "";
          scheduleStreamRender();
        },
        onStatus: (status: string) => {
          this.setStatus(status);
        },
        signal: this.abortController.signal,
      });

      streamDone = true;
      this.liveAssistantMsg = null;
      assistantMsg.content = finalResponse.content;
      assistantMsg.tool_calls = finalResponse.tool_calls;
      if (finalResponse.toolActivities) {
        assistantMsg.toolActivities = finalResponse.toolActivities;
      }
      if (finalResponse.reasoningContent) {
        assistantMsg.reasoningContent = finalResponse.reasoningContent;
      }
      if (finalResponse.hitToolLimit) {
        assistantMsg.hitToolLimit = true;
      }
      if (finalResponse.noteChanges && finalResponse.noteChanges.length > 0) {
        assistantMsg.noteChanges = finalResponse.noteChanges;
      }
      await this.renderMessages();
      this.scrollToBottom();
      await this.saveActiveConversation();
    } catch (err: unknown) {
      streamDone = true;
      this.liveAssistantMsg = null;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (assistantMsg.toolActivities) {
        for (const step of assistantMsg.toolActivities) {
          if (step.status === "running") {
            step.status = "error";
            step.durationMs = Date.now() - step.startedAt;
            step.resultPreview = errMsg.includes("cancelled")
              ? "Cancelled by user."
              : errMsg || "Interrupted";
          }
        }
      }
      const partialChanges = this.toolExecutor.getAndClearTurnChanges();
      if (partialChanges.length > 0) {
        assistantMsg.noteChanges = partialChanges;
      }
      const hadActivity =
        (assistantMsg.toolActivities?.length || 0) > 0 || partialChanges.length > 0;
      if (hadActivity) {
        assistantMsg.canResumeTask = true;
      }
      if (errMsg.includes("cancelled")) {
        if (!assistantMsg.content.trim() && hadActivity) {
          assistantMsg.content = "*Generation paused by user.*";
        }
        await this.renderMessages();
        await this.saveActiveConversation();
        new Notice("AI response cancelled.");
      } else {
        assistantMsg.content += `\n\n❌ **Error:** ${errMsg}`;
        await this.renderMessages();
        await this.saveActiveConversation();
        new Notice(`AI Error: ${errMsg}`);
      }
    } finally {
      streamDone = true;
      this.liveAssistantMsg = null;
      this.setGenerating(false);
      this.setStatus(null);
      this.abortController = null;
    }
  }

  private async buildPromptWithContext(
    text: string,
    mentions: AttachedMentionItem[]
  ): Promise<string> {
    const includedNotePaths = new Set<string>();
    const contextBlocks: string[] = [];
    const summaryLabels: string[] = [];

    const appendTruncated = (raw: string, maxChars: number): string => {
      if (raw.length <= maxChars) return raw;
      return `${raw.slice(0, maxChars)}\n... [Truncated at ${maxChars} chars; use read_note for full text]`;
    };

    // 1. Active Note
    if (this.attachActiveNote) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        try {
          const content = await this.toolExecutor.readLiveText(activeFile);
          includedNotePaths.add(activeFile.path);
          summaryLabels.push(`Active Note [[${activeFile.basename}]]`);
          contextBlocks.push(
            `### Active Note: [[${activeFile.path}]] (Target path for tools: path="${activeFile.path}")\n${appendTruncated(content, 24000)}`
          );
        } catch {
          // Ignore unreadable active note
        }
      }
    }

    // 2. Explicitly @-mentioned Notes & Folders from chips bar
    for (const m of mentions) {
      if (m.kind === "folder") {
        const folder = this.app.vault.getAbstractFileByPath(m.path);
        if (folder instanceof TFolder) {
          const entries = folder.children.slice(0, 60).map((child) => {
            if (child instanceof TFolder) return `- 📁 ${child.path}/`;
            return `- 📝 [[${child.path}]]`;
          });
          summaryLabels.push(`📁 ${m.label}`);
          contextBlocks.push(
            `### Referenced Folder: ${folder.path}/\n${
              entries.length > 0 ? entries.join("\n") : "(Empty folder)"
            }`
          );
        }
        continue;
      }

      if (includedNotePaths.has(m.path)) continue;
      const abstract = this.app.vault.getAbstractFileByPath(m.path);
      if (abstract instanceof TFile) {
        try {
          const content = await this.app.vault.read(abstract);
          includedNotePaths.add(abstract.path);
          summaryLabels.push(`[[${abstract.basename}]]`);
          contextBlocks.push(
            `### Referenced Note: [[${abstract.path}]]\n${appendTruncated(content, 12000)}`
          );
        } catch {
          // Ignore unreadable mentioned note
        }
      }
    }

    // 3. Also resolve any manually typed [[Note]] wikilinks in the prompt (up to 5 additional notes)
    const linkMatches = text.match(/\[\[([^\]]+)\]\]/g) || [];
    let extraCount = 0;
    for (const rawLink of linkMatches) {
      if (extraCount >= 5) break;
      const inner = rawLink.slice(2, -2).split("|")[0].split("#")[0].trim();
      if (!inner || inner.endsWith("/")) continue;
      const resolved = this.app.metadataCache.getFirstLinkpathDest(
        inner.replace(/\.md$/i, ""),
        ""
      );
      if (resolved instanceof TFile && !includedNotePaths.has(resolved.path)) {
        try {
          const content = await this.app.vault.read(resolved);
          includedNotePaths.add(resolved.path);
          summaryLabels.push(`[[${resolved.basename}]]`);
          contextBlocks.push(
            `### Referenced Note: [[${resolved.path}]]\n${appendTruncated(content, 12000)}`
          );
          extraCount++;
        } catch {
          // Ignore unreadable linked note
        }
      }
    }

    if (contextBlocks.length === 0) {
      return text;
    }

    return `[Context: ${summaryLabels.join(", ")}]\n${contextBlocks.join(
      "\n\n"
    )}\n===USER_PROMPT===\n${text}`;
  }

  private getTurnActiveChanges(messageIndex: number): {
    changes: NoteChangeRecord[];
    affectedMsgIndices: number[];
  } {
    const targetMsg = this.messages[messageIndex];
    const changes: NoteChangeRecord[] = [];
    const affectedMsgIndices: number[] = [];

    if (!targetMsg) return { changes, affectedMsgIndices };

    if (!targetMsg.changesReverted && targetMsg.noteChanges?.length) {
      const active = targetMsg.noteChanges.filter((c) => !c.reverted);
      if (active.length > 0) {
        changes.push(...active);
        affectedMsgIndices.push(messageIndex);
      }
    }

    // If reversing a user turn, collect un-reverted changes across all assistant/tool replies in this turn
    if (targetMsg.role === "user") {
      for (let j = messageIndex + 1; j < this.messages.length; j++) {
        const subsequent = this.messages[j];
        if (subsequent.role === "user") break;
        if (!subsequent.changesReverted && subsequent.noteChanges?.length) {
          const active = subsequent.noteChanges.filter((c) => !c.reverted);
          if (active.length > 0) {
            changes.push(...active);
            affectedMsgIndices.push(j);
          }
        }
      }
    }

    return { changes, affectedMsgIndices };
  }

  public async handleRevertMessage(
    messageIndex: number,
    fromInlineBadge: boolean = false
  ): Promise<void> {
    if (this.isGenerating) return;
    const targetMsg = this.messages[messageIndex];
    if (!targetMsg) return;

    const { changes, affectedMsgIndices } = this.getTurnActiveChanges(messageIndex);

    const applyRevert = async (
      selectedChanges: NoteChangeRecord[],
      removeMessages: boolean
    ): Promise<void> => {
      let revertedDescriptions: string[] = [];
      if (selectedChanges.length > 0) {
        revertedDescriptions = await this.toolExecutor.revertChanges(
          selectedChanges
        );
        for (const idx of affectedMsgIndices) {
          const m = this.messages[idx];
          if (m && m.noteChanges && m.noteChanges.length > 0) {
            m.changesReverted = m.noteChanges.every((c) => Boolean(c.reverted));
          }
        }
      }

      if (removeMessages) {
        if (targetMsg.role === "user") {
          const { prompt: rawPrompt } = this.extractPromptAndContext(
            targetMsg.content
          );
          this.inputEl.value = rawPrompt;
          this.inputEl.focus();

          let deleteCount = 1;
          while (
            messageIndex + deleteCount < this.messages.length &&
            this.messages[messageIndex + deleteCount].role !== "user"
          ) {
            deleteCount++;
          }
          this.messages.splice(messageIndex, deleteCount);
        } else {
          let startIndex = messageIndex;
          while (
            startIndex > 0 &&
            this.messages[startIndex - 1].role === "tool"
          ) {
            startIndex--;
          }
          const count = messageIndex - startIndex + 1;
          this.messages.splice(startIndex, count);
        }

        if (this.messages.length === 0) {
          this.messages.push(this.createDefaultGreetingMessage());
        }
      }

      await this.renderMessages();
      await this.saveActiveConversation();

      if (revertedDescriptions.length > 0) {
        new Notice(
          `↩️ Reverted AI vault changes:\n${revertedDescriptions.join("\n")}`,
          6000
        );
      } else if (removeMessages) {
        new Notice("↩️ Undid message.");
      }
    };

    // Inspect live state for conflicts & diffs, then show Disclaimer Confirmation Card Popup
    if (changes.length > 0) {
      const inspectedItems = await this.toolExecutor.inspectChangesForRevert(
        changes
      );
      new RevertConfirmModal(this.app, {
        inspectedItems,
        defaultRemoveMessage: !fromInlineBadge,
        isUserTurn: targetMsg.role === "user",
        onConfirm: async (selectedChanges, removeMessage) => {
          await applyRevert(selectedChanges, removeMessage);
        },
      }).open();
      return;
    }

    // No active note/folder changes attached to this message; remove message turn directly
    if (!fromInlineBadge) {
      await applyRevert([], true);
    }
  }

  public async handleReapplyMessage(messageIndex: number): Promise<void> {
    if (this.isGenerating) return;
    const msg = this.messages[messageIndex];
    if (!msg || !msg.noteChanges || msg.noteChanges.length === 0) return;

    const toReapply = msg.noteChanges.filter(
      (c) => c.reverted || msg.changesReverted
    );
    if (toReapply.length === 0) return;

    for (const c of toReapply) {
      c.reverted = true;
    }

    const descriptions = await this.toolExecutor.reapplyChanges(toReapply);
    msg.changesReverted = msg.noteChanges.every((c) => Boolean(c.reverted));

    await this.renderMessages();
    await this.saveActiveConversation();

    if (descriptions.length > 0) {
      new Notice(
        `↪️ Re-applied AI vault changes:\n${descriptions.join("\n")}`,
        6000
      );
    } else {
      new Notice("No reverted changes could be re-applied.");
    }
  }

  private formatChangeLabels(records: NoteChangeRecord[]): string[] {
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const c of records) {
      const baseName = c.path.split("/").pop() || c.path;
      const label =
        c.itemKind === "folder"
          ? `📁 ${baseName}`
          : `[[${baseName.replace(/\.md$/, "")}]]`;
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    }
    return labels;
  }

  private async renderMessages(): Promise<void> {
    this.chatContainerEl.empty();

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === "system") continue;

      const msgWrapper = this.chatContainerEl.createDiv({
        cls: `ai-message-bubble ${msg.role === "user" ? "user-bubble" : "assistant-bubble"}`,
      });

      const msgHeader = msgWrapper.createDiv({ cls: "ai-message-header" });
      const roleLabel = msgHeader.createSpan({ cls: "ai-role-label" });

      if (msg.role === "user") {
        roleLabel.setText("You");
      } else if (msg.role === "assistant") {
        roleLabel.setText("AI Assistant");
      } else if (msg.role === "tool") {
        roleLabel.setText(`Tool (${msg.name || "vault"})`);
      }

      const actionsBox = msgHeader.createDiv({ cls: "ai-message-actions" });

      // If assistant, add Copy, Insert, Create Note
      if (msg.role === "assistant") {
        this.renderAssistantActions(actionsBox, msg.content);
      }

      // Revert / Undo icon button on user prompts only (same unified revert flow for every prompt)
      if (msg.role === "user") {
        const { changes: turnActiveChanges } = this.getTurnActiveChanges(i);
        const hasActiveChanges = turnActiveChanges.length > 0;
        const revertBtn = actionsBox.createEl("button", {
          cls: `ai-action-btn revert-msg ${hasActiveChanges ? "has-vault-changes" : ""}`,
          attr: {
            title: hasActiveChanges
              ? `Review & revert ${turnActiveChanges.length} AI note/folder change(s) from this prompt`
              : "Revert / Undo this prompt",
          },
        });
        setIcon(revertBtn, "undo");
        revertBtn.addEventListener("click", () => {
          void this.handleRevertMessage(i, false);
        });
      }

      if (msg.role === "assistant") {
        const activityHostEl = msgWrapper.createDiv({
          cls: "ai-activity-host hidden",
        });
        this.renderAssistantActivityDropdown(
          activityHostEl,
          msg,
          this.liveAssistantMsg === msg
        );
      }

      const contentEl = msgWrapper.createDiv({ cls: "ai-message-content" });

      let displayContent = msg.content;
      if (msg.role === "user") {
        const parsed = this.extractPromptAndContext(displayContent);
        displayContent = parsed.prompt;
        if (parsed.contextLabel) {
          const noteTag = contentEl.createDiv({ cls: "ai-context-indicator" });
          noteTag.setText(`📎 ${parsed.contextLabel}`);
        }
      }

      await MarkdownRenderer.render(
        this.app,
        displayContent || "*(Thinking...)*",
        contentEl,
        "",
        this
      );
      this.wrapTablesInContainer(contentEl);

      if (msg.noteChanges && msg.noteChanges.length > 0) {
        this.renderVaultChangesFooter(msgWrapper, msg, i);
      }

      if (msg.role === "assistant" && (msg.hitToolLimit || msg.canResumeTask)) {
        const continueWrap = msgWrapper.createDiv({ cls: "ai-continue-limit-bar" });
        continueWrap.createSpan({
          cls: "ai-continue-limit-text",
          text: msg.hitToolLimit
            ? "Paused after max checkpoints."
            : "Task interrupted — switch model or retry to resume.",
        });
        const continueBtn = continueWrap.createEl("button", {
          cls: "mod-cta ai-continue-limit-btn",
          text: "Continue Task",
          attr: { title: "Resume remaining steps from where the assistant stopped" },
        });
        continueBtn.addEventListener("click", () => {
          void (async () => {
            if (this.isGenerating) return;
            const wasInterrupted = Boolean(msg.canResumeTask && !msg.hitToolLimit);
            msg.hitToolLimit = false;
            msg.canResumeTask = false;
            if (wasInterrupted && msg.toolActivities && msg.toolActivities.length > 0) {
              const doneSteps = msg.toolActivities
                .filter((s) => s.status === "completed")
                .slice(-12)
                .map((s) => `- ${s.label}`);
              this.inputEl.value =
                doneSteps.length > 0
                  ? `The previous run was interrupted. Completed tool steps so far:\n${doneSteps.join(
                      "\n"
                    )}\n\nPlease resume from here and complete the remaining steps.`
                  : "The previous run was interrupted. Please continue and complete the remaining steps.";
            } else {
              this.inputEl.value = "Please continue and complete the remaining steps.";
            }
            await this.handleSend();
          })();
        });
      }
    }
  }

  private wrapTablesInContainer(containerEl: HTMLElement): void {
    const tables = containerEl.querySelectorAll("table");
    tables.forEach((table) => {
      if (table.parentElement?.classList.contains("ai-table-wrap")) return;
      const wrap = createDiv({ cls: "ai-table-wrap" });
      table.parentNode?.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  private formatDurationMs(ms?: number): string {
    if (typeof ms !== "number" || ms < 0) return "";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private dedupeChangeRecords(records: NoteChangeRecord[]): NoteChangeRecord[] {
    const byKey = new Map<string, NoteChangeRecord>();
    for (const r of records) {
      const key = `${r.itemKind || "note"}:${r.path}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...r });
      } else {
        // Keep earliest previousContent and latest newContent/type
        byKey.set(key, {
          ...r,
          previousContent: existing.previousContent,
        });
      }
    }
    return Array.from(byKey.values());
  }

  private findFirstChangedLine(
    prevText: string | null | undefined,
    nextText: string
  ): number {
    if (prevText === null || prevText === undefined) return 0;
    const prevLines = prevText.split(/\r?\n/);
    const nextLines = nextText.split(/\r?\n/);
    const maxLen = Math.max(prevLines.length, nextLines.length);
    for (let i = 0; i < maxLen; i++) {
      if ((prevLines[i] ?? "") !== (nextLines[i] ?? "")) {
        return Math.min(i, Math.max(0, nextLines.length - 1));
      }
    }
    return 0;
  }

  private async openChangedItem(
    record: NoteChangeRecord,
    msgIndex: number
  ): Promise<void> {
    if (record.itemKind === "folder" || record.type === "deleted") {
      void this.handleRevertMessage(msgIndex, true);
      return;
    }

    const abstract = this.app.vault.getAbstractFileByPath(record.path);
    if (!(abstract instanceof TFile)) {
      void this.handleRevertMessage(msgIndex, true);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(abstract);

    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const latestText =
        typeof record.newContent === "string"
          ? record.newContent
          : await this.app.vault.read(abstract);
      const changedLine = this.findFirstChangedLine(
        record.previousContent,
        latestText
      );
      const editor = view.editor;
      const lineLen = editor.getLine(changedLine)?.length ?? 0;
      editor.setSelection(
        { line: changedLine, ch: 0 },
        { line: changedLine, ch: lineLen }
      );
      editor.scrollIntoView(
        {
          from: { line: changedLine, ch: 0 },
          to: { line: changedLine, ch: lineLen },
        },
        true
      );
      editor.focus();
    }
  }

  private renderChangedChip(
    parentEl: HTMLElement,
    record: NoteChangeRecord,
    msgIndex: number,
    isReverted: boolean
  ): void {
    const baseName = record.path.split("/").pop() || record.path;
    const cleanLabel =
      record.itemKind === "folder"
        ? baseName
        : baseName.replace(/\.md$/i, "");

    const typeHint =
      record.type === "created"
        ? "Created"
        : record.type === "deleted"
          ? "Deleted"
          : record.type === "renamed"
            ? "Moved"
            : "Edited";

    const chipBtn = parentEl.createEl("button", {
      cls: `ai-changed-file-chip type-${record.type} ${
        isReverted ? "is-reverted" : ""
      }`,
      attr: {
        type: "button",
        title:
          record.type === "deleted" || record.itemKind === "folder"
            ? `${typeHint}: ${record.path} (click to inspect)`
            : `${typeHint}: ${record.path} (click to jump to changes)`,
      },
    });

    const chipIcon = chipBtn.createSpan({ cls: "ai-changed-chip-icon" });
    setIcon(
      chipIcon,
      record.itemKind === "folder" ? "folder" : "file-text"
    );
    chipBtn.createSpan({
      cls: "ai-changed-chip-name",
      text: cleanLabel,
    });

    chipBtn.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void this.openChangedItem(record, msgIndex);
    });
  }

  private renderVaultChangesFooter(
    msgWrapper: HTMLElement,
    msg: ChatMessage,
    msgIndex: number
  ): void {
    if (!msg.noteChanges || msg.noteChanges.length === 0) return;

    const rawActive = msg.changesReverted
      ? []
      : msg.noteChanges.filter((c) => !c.reverted);
    const rawReverted = msg.changesReverted
      ? msg.noteChanges
      : msg.noteChanges.filter((c) => c.reverted);

    const activeRecords = this.dedupeChangeRecords(rawActive);
    const revertedRecords = this.dedupeChangeRecords(rawReverted);
    if (activeRecords.length === 0 && revertedRecords.length === 0) return;

    const footerEl = msgWrapper.createDiv({ cls: "ai-changes-footer" });

    if (activeRecords.length > 0) {
      const isExpanded = this.changesExpandedState.get(msg) ?? false;
      const rowEl = footerEl.createDiv({ cls: "ai-changes-row" });

      const leftEl = rowEl.createDiv({ cls: "ai-changes-row-left" });
      const iconSpan = leftEl.createSpan({ cls: "ai-note-changes-icon" });
      setIcon(iconSpan, "rotate-ccw");

      if (activeRecords.length === 1) {
        leftEl.createSpan({
          cls: "ai-changes-verb",
          text:
            activeRecords[0].type === "created"
              ? "Created"
              : activeRecords[0].type === "deleted"
                ? "Deleted"
                : activeRecords[0].type === "renamed"
                  ? "Moved"
                  : "Edited",
        });
        this.renderChangedChip(leftEl, activeRecords[0], msgIndex, false);
      } else {
        const listToggleBtn = leftEl.createEl("button", {
          cls: "ai-changes-expand-btn",
          attr: {
            type: "button",
            "aria-expanded": String(isExpanded),
            title: isExpanded
              ? "Hide modified notes"
              : "Show modified notes (clickable)",
          },
        });
        listToggleBtn.createSpan({
          text: `Modified ${activeRecords.length} files`,
        });
        const chev = listToggleBtn.createSpan({ cls: "ai-changes-chev" });
        setIcon(chev, isExpanded ? "chevron-down" : "chevron-right");

        listToggleBtn.addEventListener("click", (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          this.changesExpandedState.set(msg, !isExpanded);
          footerEl.remove();
          this.renderVaultChangesFooter(msgWrapper, msg, msgIndex);
        });
      }

      if (activeRecords.length > 1 && isExpanded) {
        const chipsWrap = footerEl.createDiv({ cls: "ai-changes-chips-list" });
        for (const rec of activeRecords) {
          this.renderChangedChip(chipsWrap, rec, msgIndex, false);
        }
      }
    }

    if (revertedRecords.length > 0) {
      const revRow = footerEl.createDiv({ cls: "ai-changes-row is-reverted" });
      const revLeft = revRow.createDiv({ cls: "ai-changes-row-left" });
      const revIcon = revLeft.createSpan({ cls: "ai-note-changes-icon reverted" });
      setIcon(revIcon, "check");

      if (revertedRecords.length === 1) {
        revLeft.createSpan({ cls: "ai-changes-verb", text: "Reverted" });
        this.renderChangedChip(revLeft, revertedRecords[0], msgIndex, true);
      } else {
        revLeft.createSpan({
          cls: "ai-changes-verb",
          text: `Reverted ${revertedRecords.length} files`,
        });
      }

      const reapplyBtn = revRow.createEl("button", {
        cls: "ai-inline-reapply-btn",
        text: "Re-apply",
        attr: {
          type: "button",
          title: "Redo / re-apply these reverted AI changes",
        },
      });
      reapplyBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        void this.handleReapplyMessage(msgIndex);
      });
    }
  }

  /**
   * Renders the collapsible tool execution & reasoning trace dropdown for an assistant message.
   */
  private renderAssistantActivityDropdown(
    hostEl: HTMLElement,
    msg: ChatMessage,
    isLive: boolean
  ): void {
    const tools = msg.toolActivities || [];
    const reasoning = (msg.reasoningContent || "").trim();

    if (tools.length === 0 && !reasoning) {
      hostEl.empty();
      hostEl.addClass("hidden");
      return;
    }

    hostEl.removeClass("hidden");
    hostEl.empty();

    const isExpanded = this.activityExpandedState.get(msg) ?? false;
    const runningStep = [...tools].reverse().find((t) => t.status === "running");
    const errorCount = tools.filter((t) => t.status === "error").length;

    const dropdownEl = hostEl.createDiv({
      cls: `ai-activity-dropdown ${isExpanded ? "is-expanded" : ""} ${
        runningStep ? "is-running" : ""
      } ${errorCount > 0 && !runningStep ? "has-errors" : ""}`,
    });

    const toggleBtn = dropdownEl.createEl("button", {
      cls: "ai-activity-toggle",
      attr: {
        type: "button",
        "aria-expanded": String(isExpanded),
        title: isExpanded
          ? "Hide tool & thinking steps"
          : "Show tool & thinking steps",
      },
    });

    const iconEl = toggleBtn.createSpan({ cls: "ai-activity-icon" });
    if (runningStep) {
      iconEl.addClass("is-spinning");
      setIcon(iconEl, "loader");
    } else if (isLive && reasoning && tools.length === 0 && !msg.content) {
      iconEl.addClass("is-spinning");
      setIcon(iconEl, "loader");
    } else if (errorCount > 0) {
      iconEl.addClass("is-error");
      setIcon(iconEl, "alert-circle");
    } else if (tools.length > 0) {
      setIcon(iconEl, "wrench");
    } else {
      setIcon(iconEl, "brain");
    }

    let summaryText = "";
    if (runningStep) {
      summaryText = `${runningStep.label}… (${tools.length})`;
    } else if (isLive && reasoning && tools.length === 0 && !msg.content) {
      summaryText = "Thinking…";
    } else {
      const parts: string[] = [];
      if (tools.length > 0) {
        const unit = tools.length === 1 ? "tool" : "tools";
        parts.push(`Used ${tools.length} ${unit}`);
      }
      if (reasoning) {
        parts.push(tools.length > 0 ? "Thought process" : "Thought process");
      }
      if (errorCount > 0) {
        parts.push(`${errorCount} issue${errorCount > 1 ? "s" : ""}`);
      }
      summaryText = parts.join(" · ");
    }

    toggleBtn.createSpan({
      cls: "ai-activity-summary-text",
      text: summaryText,
    });

    const chevEl = toggleBtn.createSpan({ cls: "ai-activity-chevron" });
    setIcon(chevEl, isExpanded ? "chevron-down" : "chevron-right");

    toggleBtn.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !isExpanded;
      this.activityExpandedState.set(msg, next);
      this.renderAssistantActivityDropdown(hostEl, msg, isLive);
    });

    if (!isExpanded) return;

    const bodyEl = dropdownEl.createDiv({ cls: "ai-activity-body" });

    if (reasoning) {
      const reasonSection = bodyEl.createDiv({ cls: "ai-activity-reasoning" });
      const reasonHeader = reasonSection.createDiv({
        cls: "ai-activity-section-title",
      });
      const rIcon = reasonHeader.createSpan({ cls: "ai-activity-section-icon" });
      setIcon(rIcon, "brain");
      reasonHeader.createSpan({ text: "Thought Process" });

      const reasonBody = reasonSection.createDiv({
        cls: "ai-activity-reasoning-text",
        text: reasoning,
      });
      if (isLive) {
        reasonBody.scrollTop = reasonBody.scrollHeight;
      }
    }

    if (tools.length > 0) {
      const stepsListEl = bodyEl.createDiv({ cls: "ai-activity-steps" });
      for (const step of tools) {
        const hasDetails = Boolean(step.argsPreview || step.resultPreview);
        const stepOpen = this.stepDetailExpanded.has(step.id);

        const stepEl = stepsListEl.createDiv({
          cls: `ai-activity-step status-${step.status}`,
        });

        const stepHeader = stepEl.createDiv({
          cls: `ai-activity-step-header ${hasDetails ? "is-clickable" : ""}`,
        });

        const stIcon = stepHeader.createSpan({ cls: "ai-activity-step-icon" });
        if (step.status === "running") {
          stIcon.addClass("is-spinning");
          setIcon(stIcon, "loader");
        } else if (step.status === "error") {
          setIcon(stIcon, "alert-circle");
        } else {
          setIcon(stIcon, "check");
        }

        stepHeader.createSpan({
          cls: "ai-activity-step-label",
          text: step.label,
        });

        const durText = this.formatDurationMs(step.durationMs);
        if (durText && step.status !== "running") {
          stepHeader.createSpan({
            cls: "ai-activity-step-duration",
            text: durText,
          });
        }

        if (hasDetails) {
          const detailChev = stepHeader.createSpan({
            cls: "ai-activity-step-chev",
          });
          setIcon(detailChev, stepOpen ? "chevron-down" : "chevron-right");

          stepHeader.addEventListener("click", (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.stepDetailExpanded.has(step.id)) {
              this.stepDetailExpanded.delete(step.id);
            } else {
              this.stepDetailExpanded.add(step.id);
            }
            this.renderAssistantActivityDropdown(hostEl, msg, isLive);
          });
        }

        if (hasDetails && stepOpen) {
          const detailsEl = stepEl.createDiv({ cls: "ai-activity-step-details" });
          if (step.argsPreview) {
            detailsEl.createDiv({
              cls: "ai-activity-detail-heading",
              text: "Input",
            });
            detailsEl.createEl("pre", {
              cls: "ai-activity-detail-pre",
              text: step.argsPreview,
            });
          }
          if (step.resultPreview) {
            detailsEl.createDiv({
              cls: "ai-activity-detail-heading",
              text: step.status === "error" ? "Error / Notice" : "Result",
            });
            detailsEl.createEl("pre", {
              cls: "ai-activity-detail-pre",
              text: step.resultPreview,
            });
          }
        }
      }
    }
  }

  private renderAssistantActions(actionsBox: HTMLElement, content: string): void {

    // Copy
    const copyBtn = actionsBox.createEl("button", {
      cls: "ai-action-btn",
      attr: { title: "Copy to Clipboard" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      void (async () => {
        await navigator.clipboard.writeText(content);
        new Notice("Copied to clipboard!");
      })();
    });

    // Insert at cursor
    const insertBtn = actionsBox.createEl("button", {
      cls: "ai-action-btn",
      attr: { title: "Insert at Cursor in Active Note" },
    });
    setIcon(insertBtn, "file-plus-2");
    insertBtn.addEventListener("click", () => {
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) {
        editor.replaceSelection(content);
        new Notice("Inserted into active editor.");
      } else {
        new Notice("No active markdown editor to insert into.");
      }
    });

    // Create new note
    const createNoteBtn = actionsBox.createEl("button", {
      cls: "ai-action-btn",
      attr: { title: "Create New Note from Response" },
    });
    setIcon(createNoteBtn, "file-plus");
    createNoteBtn.addEventListener("click", () => {
      void (async () => {
        const title = `AI Note - ${new Date().toISOString().slice(0, 10)} - ${Date.now().toString().slice(-4)}`;
        const filename = `${title}.md`;
        const file = await this.app.vault.create(filename, content);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
        new Notice(`Created note [[${filename}]]`);
      })();
    });
  }

  private scrollToBottom(): void {
    this.chatContainerEl.scrollTop = this.chatContainerEl.scrollHeight;
  }

  async onClose(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.closeModelPopup();
    this.closeReasoningPopup();
    this.closeMentionPopup();
  }
}

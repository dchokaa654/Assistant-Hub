import { App, Modal, Notice, setIcon } from "obsidian";
import { NoteChangeRecord } from "../types";
import { RevertInspectionItem, summarizeNoteChange } from "../ai/tools";
import { DiffResult } from "../ai/diff";

export interface RevertConfirmOptions {
  inspectedItems: RevertInspectionItem[];
  defaultRemoveMessage: boolean;
  isUserTurn: boolean;
  onConfirm: (
    selectedChanges: NoteChangeRecord[],
    removeMessage: boolean
  ) => Promise<void> | void;
}

export class RevertConfirmModal extends Modal {
  private options: RevertConfirmOptions;
  private selectedIndices: Set<number> = new Set();
  private removeMessage: boolean;
  private isSubmitting = false;

  private confirmBtnEl!: HTMLButtonElement;
  private confirmTextEl!: HTMLElement;
  private selectedCountEl: HTMLElement | null = null;
  private itemCheckboxes: HTMLInputElement[] = [];

  constructor(app: App, options: RevertConfirmOptions) {
    super(app);
    this.options = options;
    this.removeMessage = options.defaultRemoveMessage;
    // Select all changes by default
    options.inspectedItems.forEach((_, idx) => this.selectedIndices.add(idx));
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("ai-revert-confirm-modal");

    const items = this.options.inspectedItems;
    const conflictCount = items.filter((it) => it.hasConflict).length;

    // 1. Header Card Banner
    const header = contentEl.createDiv({ cls: "ai-revert-modal-header" });
    const iconBadge = header.createDiv({ cls: "ai-revert-header-icon" });
    setIcon(iconBadge, "rotate-ccw");

    const titleGroup = header.createDiv({ cls: "ai-revert-header-text" });
    titleGroup.createEl("h2", {
      text: "Confirm Revert Vault Changes",
      cls: "ai-revert-modal-title",
    });
    titleGroup.createDiv({
      text: `Review ${items.length} note/folder operation(s), inspect diffs, and choose what to undo.`,
      cls: "ai-revert-modal-subtitle",
    });

    // 2. Post-Turn Conflict Warning Banner (if any files changed manually after AI turn)
    if (conflictCount > 0) {
      const conflictBanner = contentEl.createDiv({
        cls: "ai-revert-conflict-banner",
      });
      const cIcon = conflictBanner.createSpan({
        cls: "ai-revert-conflict-banner-icon",
      });
      setIcon(cIcon, "alert-octagon");
      conflictBanner.createSpan({
        text: `${conflictCount} item(s) were manually edited or changed after the AI turn. Uncheck any file you want to keep as-is.`,
      });
    }

    // 3. Selection Controls + Scrollable List of Changes
    const listSection = contentEl.createDiv({ cls: "ai-revert-changes-section" });
    const topBar = listSection.createDiv({ cls: "ai-revert-select-bar" });
    topBar.createDiv({
      cls: "ai-revert-section-label",
      text: "Planned Revert Actions (Reverse Order):",
    });

    if (items.length > 1) {
      const selectControls = topBar.createDiv({
        cls: "ai-revert-select-controls",
      });
      this.selectedCountEl = selectControls.createSpan({
        cls: "ai-revert-selected-count",
        text: `${this.selectedIndices.size}/${items.length} selected`,
      });

      const selectAllBtn = selectControls.createEl("button", {
        cls: "ai-revert-select-btn",
        text: "All",
      });
      selectAllBtn.addEventListener("click", () => {
        items.forEach((_, idx) => this.selectedIndices.add(idx));
        this.syncSelectionUI();
      });

      const selectNoneBtn = selectControls.createEl("button", {
        cls: "ai-revert-select-btn",
        text: "None",
      });
      selectNoneBtn.addEventListener("click", () => {
        this.selectedIndices.clear();
        this.syncSelectionUI();
      });
    }

    const listEl = listSection.createDiv({ cls: "ai-revert-changes-list" });
    this.itemCheckboxes = [];

    // Display in reverse chronological execution order (LIFO)
    const reversedWithOrigIdx = items
      .map((item, origIdx) => ({ item, origIdx }))
      .reverse();

    for (const { item, origIdx } of reversedWithOrigIdx) {
      const { record, hasConflict, conflictReason, diff, isDiffable } = item;
      const info = summarizeNoteChange(record);

      const itemEl = listEl.createDiv({
        cls: `ai-revert-change-item type-${record.type} kind-${
          record.itemKind || "note"
        } ${hasConflict ? "has-conflict" : ""}`,
      });

      const rowMain = itemEl.createDiv({ cls: "ai-revert-item-row" });

      // Per-file checkbox
      const cb = rowMain.createEl("input", {
        type: "checkbox",
        cls: "ai-revert-item-checkbox",
      });
      cb.checked = this.selectedIndices.has(origIdx);
      cb.dataset.origIdx = String(origIdx);
      cb.addEventListener("change", () => {
        if (cb.checked) {
          this.selectedIndices.add(origIdx);
        } else {
          this.selectedIndices.delete(origIdx);
        }
        this.syncSelectionUI();
      });
      this.itemCheckboxes.push(cb);

      const itemIcon = rowMain.createSpan({ cls: "ai-revert-item-icon" });
      setIcon(itemIcon, info.icon);

      const itemBody = rowMain.createDiv({ cls: "ai-revert-item-body" });
      const topLine = itemBody.createDiv({ cls: "ai-revert-item-top" });
      topLine.createSpan({
        cls: `ai-revert-action-tag tag-${record.type}`,
        text: info.actionTag,
      });
      topLine.createSpan({
        cls: "ai-revert-item-path",
        text: info.label,
      });

      itemBody.createDiv({
        cls: "ai-revert-item-effect",
        text: `↪ ${info.revertEffect}`,
      });

      if (hasConflict && conflictReason) {
        const conflictBadge = itemBody.createDiv({
          cls: "ai-revert-conflict-badge",
        });
        const warnSm = conflictBadge.createSpan({
          cls: "ai-revert-conflict-sm-icon",
        });
        setIcon(warnSm, "alert-triangle");
        conflictBadge.createSpan({ text: conflictReason });
      }

      // Diff toggle button & expandable visual diff block
      if (isDiffable && diff) {
        const diffBtn = rowMain.createEl("button", {
          cls: "ai-revert-diff-toggle-btn",
          attr: { title: "Inspect line-by-line revert diff" },
        });
        const statsEl = diffBtn.createSpan({ cls: "ai-revert-diff-stats" });
        if (diff.addedCount > 0) {
          statsEl.createSpan({
            cls: "ai-diff-stat-add",
            text: `+${diff.addedCount}`,
          });
        }
        if (diff.removedCount > 0) {
          statsEl.createSpan({
            cls: "ai-diff-stat-del",
            text: `-${diff.removedCount}`,
          });
        }
        if (diff.addedCount === 0 && diff.removedCount === 0) {
          statsEl.createSpan({ text: "No text delta" });
        }
        const chevronSpan = diffBtn.createSpan({
          cls: "ai-revert-diff-chevron",
        });
        setIcon(chevronSpan, "chevron-down");

        const diffWrap = itemEl.createDiv({ cls: "ai-revert-diff-container" });
        const autoExpand =
          items.length === 1 && diff.lines.length > 0 && diff.lines.length <= 28;
        if (!autoExpand) {
          diffWrap.addClass("hidden");
        } else {
          diffBtn.addClass("expanded");
          this.renderDiffLines(diffWrap, diff);
        }

        let rendered = autoExpand;
        diffBtn.addEventListener("click", (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (!rendered) {
            this.renderDiffLines(diffWrap, diff);
            rendered = true;
          }
          const isHidden = diffWrap.hasClass("hidden");
          if (isHidden) {
            diffWrap.removeClass("hidden");
            diffBtn.addClass("expanded");
          } else {
            diffWrap.addClass("hidden");
            diffBtn.removeClass("expanded");
          }
        });
      }
    }

    // 4. Prominent Disclaimer Card Box
    const disclaimerBox = contentEl.createDiv({
      cls: "ai-revert-disclaimer-box",
    });
    const disclaimerHeader = disclaimerBox.createDiv({
      cls: "ai-revert-disclaimer-header",
    });
    const warnIcon = disclaimerHeader.createSpan({
      cls: "ai-revert-disclaimer-icon",
    });
    setIcon(warnIcon, "alert-triangle");
    disclaimerHeader.createSpan({
      text: "Disclaimer — Safe Rollback & Recovery",
      cls: "ai-revert-disclaimer-title",
    });

    const disclaimerList = disclaimerBox.createEl("ul", {
      cls: "ai-revert-disclaimer-list",
    });
    disclaimerList.createEl("li", {
      text: "Only the checked notes and folders above will be reverted to their pre-turn state; unchecked items remain untouched.",
    });
    disclaimerList.createEl("li", {
      text: "Reverting an edited file overwrites its current contents (a Redo snapshot is saved so you can re-apply if needed).",
    });
    disclaimerList.createEl("li", {
      text: "Newly created files are moved to Obsidian trash; non-empty folders containing other files are preserved.",
    });

    // 5. Optional Remove Message Turn Checkbox
    const optionRow = contentEl.createDiv({ cls: "ai-revert-option-row" });
    const label = optionRow.createEl("label", {
      cls: "ai-revert-checkbox-label",
    });
    const checkbox = label.createEl("input", {
      type: "checkbox",
      cls: "ai-revert-checkbox",
    });
    checkbox.checked = this.removeMessage;
    checkbox.addEventListener("change", () => {
      this.removeMessage = checkbox.checked;
    });

    const labelText = this.options.isUserTurn
      ? "Also remove this message turn from chat and restore my prompt to the input box"
      : "Also remove this AI response from conversation history";
    label.createSpan({ text: labelText });

    // 6. Action Buttons Footer
    const footer = contentEl.createDiv({ cls: "ai-revert-modal-footer" });

    const cancelBtn = footer.createEl("button", {
      cls: "ai-revert-cancel-btn",
      text: "Cancel",
    });
    cancelBtn.addEventListener("click", () => {
      if (!this.isSubmitting) {
        this.close();
      }
    });

    this.confirmBtnEl = footer.createEl("button", {
      cls: "mod-warning ai-revert-confirm-btn",
    });
    const btnIcon = this.confirmBtnEl.createSpan({ cls: "ai-revert-btn-icon" });
    setIcon(btnIcon, "rotate-ccw");
    this.confirmTextEl = this.confirmBtnEl.createSpan({
      text: this.getConfirmButtonLabel(),
    });

    this.confirmBtnEl.addEventListener("click", async () => {
      if (this.isSubmitting || this.selectedIndices.size === 0) return;
      this.isSubmitting = true;
      this.confirmBtnEl.setAttr("disabled", "true");
      cancelBtn.setAttr("disabled", "true");
      this.confirmTextEl.setText("Reverting...");

      const selectedChanges = items
        .filter((_, idx) => this.selectedIndices.has(idx))
        .map((it) => it.record);

      try {
        await this.options.onConfirm(selectedChanges, this.removeMessage);
        this.close();
      } catch (err: any) {
        this.isSubmitting = false;
        this.confirmBtnEl.removeAttribute("disabled");
        cancelBtn.removeAttribute("disabled");
        this.confirmTextEl.setText(this.getConfirmButtonLabel());
        new Notice(`Failed to revert changes: ${err?.message || String(err)}`);
      }
    });
  }

  private getConfirmButtonLabel(): string {
    const count = this.selectedIndices.size;
    if (count === 0) return "Select Items to Revert";
    if (count === this.options.inspectedItems.length) {
      return `Confirm Revert (${count})`;
    }
    return `Revert Selected (${count})`;
  }

  private syncSelectionUI(): void {
    const items = this.options.inspectedItems;
    for (const cb of this.itemCheckboxes) {
      const idx = parseInt(cb.dataset.origIdx || "-1", 10);
      cb.checked = this.selectedIndices.has(idx);
    }
    if (this.selectedCountEl) {
      this.selectedCountEl.setText(
        `${this.selectedIndices.size}/${items.length} selected`
      );
    }
    if (this.confirmTextEl) {
      this.confirmTextEl.setText(this.getConfirmButtonLabel());
    }
    if (this.confirmBtnEl) {
      if (this.selectedIndices.size === 0) {
        this.confirmBtnEl.setAttr("disabled", "true");
      } else {
        this.confirmBtnEl.removeAttribute("disabled");
      }
    }
  }

  private renderDiffLines(container: HTMLElement, diff: DiffResult): void {
    container.empty();
    const headerBar = container.createDiv({ cls: "ai-diff-header-bar" });
    headerBar.createSpan({
      text: "Revert Preview: ",
      cls: "ai-diff-header-title",
    });
    headerBar.createSpan({
      text: "− removed",
      cls: "ai-diff-legend-del",
    });
    headerBar.createSpan({ text: " / " });
    headerBar.createSpan({
      text: "+ restored",
      cls: "ai-diff-legend-add",
    });

    if (diff.lines.length === 0) {
      container.createDiv({
        cls: "ai-diff-empty",
        text: "File content currently matches the original pre-turn content.",
      });
      return;
    }

    const codeBox = container.createDiv({ cls: "ai-diff-lines-box" });
    for (const line of diff.lines) {
      if (line.type === "ellipsis") {
        codeBox.createDiv({
          cls: "ai-diff-line ellipsis",
          text: line.text,
        });
        continue;
      }

      const row = codeBox.createDiv({ cls: `ai-diff-line ${line.type}` });
      const lnOld = row.createSpan({
        cls: "ai-diff-ln",
        text: line.oldLine !== undefined ? String(line.oldLine) : "",
      });
      const lnNew = row.createSpan({
        cls: "ai-diff-ln",
        text: line.newLine !== undefined ? String(line.newLine) : "",
      });
      row.createSpan({
        cls: "ai-diff-prefix",
        text: line.type === "add" ? "+" : line.type === "remove" ? "-" : " ",
      });
      row.createSpan({
        cls: "ai-diff-text",
        text: line.text === "" ? " " : line.text,
      });
      void lnOld;
      void lnNew;
    }

    if (diff.truncated) {
      codeBox.createDiv({
        cls: "ai-diff-line ellipsis",
        text: "... Diff preview truncated for display performance ...",
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

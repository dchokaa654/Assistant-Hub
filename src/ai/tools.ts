import {
  App,
  MarkdownView,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import {
  DeletedVaultItemSnapshot,
  NoteChangeRecord,
  VaultToolDefinition,
} from "../types";
import { computeLineDiff, DiffResult } from "./diff";

export interface ToolExecutionContext {
  app: App;
  notifyStatus?: (message: string) => void;
}

export interface RevertInspectionItem {
  record: NoteChangeRecord;
  hasConflict: boolean;
  conflictReason?: string;
  diff?: DiffResult;
  isDiffable: boolean;
}

const TEXT_FILE_EXTENSIONS = new Set([
  "md",
  "txt",
  "canvas",
  "json",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "ts",
  "jsx",
  "tsx",
  "py",
  "sql",
  "sh",
  "bat",
  "ps1",
  "ini",
  "toml",
  "log",
  "svg",
]);

const MAX_BINARY_SNAPSHOT_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

function isTextFileExtension(ext: string): boolean {
  return TEXT_FILE_EXTENSIONS.has((ext || "").toLowerCase());
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function summarizeNoteChange(record: NoteChangeRecord): {
  icon: string;
  actionTag: string;
  label: string;
  revertEffect: string;
} {
  const isFolder = record.itemKind === "folder";

  if (isFolder) {
    switch (record.type) {
      case "created":
        return {
          icon: "folder-plus",
          actionTag: "Created Folder",
          label: record.path,
          revertEffect: `Remove created folder "${record.path}" (if empty)`,
        };
      case "renamed":
        return {
          icon: "folder-symlink",
          actionTag: "Moved Folder",
          label: `${record.previousPath || "?"} → ${record.path}`,
          revertEffect: `Move folder back to "${record.previousPath || "?"}"`,
        };
      case "deleted": {
        const count = record.folderSnapshot?.length || 0;
        return {
          icon: "folder-x",
          actionTag: "Deleted Folder",
          label: record.path,
          revertEffect: `Restore deleted folder "${record.path}" (${count} item(s))`,
        };
      }
      default:
        return {
          icon: "folder",
          actionTag: "Updated Folder",
          label: record.path,
          revertEffect: `Revert folder "${record.path}"`,
        };
    }
  }

  switch (record.type) {
    case "created":
      return {
        icon: "file-plus",
        actionTag: "Created Note",
        label: record.path,
        revertEffect: `Move newly created note "${record.path}" to trash`,
      };
    case "modified":
      return {
        icon: "file-edit",
        actionTag: "Edited Note",
        label: record.path,
        revertEffect: `Restore previous content of "${record.path}"`,
      };
    case "renamed":
      return {
        icon: "file-symlink",
        actionTag: "Moved Note",
        label: `${record.previousPath || "?"} → ${record.path}`,
        revertEffect: `Move note back to "${record.previousPath || "?"}"`,
      };
    case "deleted":
      return {
        icon: "file-minus",
        actionTag: "Deleted Note",
        label: record.path,
        revertEffect: `Recreate deleted note "${record.path}" with original content`,
      };
    default:
      return {
        icon: "file-text",
        actionTag: "Changed Note",
        label: record.path,
        revertEffect: `Revert changes to "${record.path}"`,
      };
  }
}

export const VAULT_TOOL_DEFINITIONS: VaultToolDefinition[] = [
  // ==========================================
  // Discovery: All Notes, Files & Folders
  // ==========================================
  {
    name: "search_vault",
    description:
      "Search across all folders, markdown notes, and files in the Obsidian vault by folder name, title, tags, or content keywords. Returns matched paths and excerpt snippets.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keywords or phrase to find in folder names, note titles, or note contents.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_folders_and_files",
    description:
      "Inspect the directory tree of the Obsidian vault or a specific folder. Lists all folders (including empty folders), markdown notes, and other vault files.",
    parameters: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description:
            "Optional folder path to inspect (e.g. 'Work/Projects'). Leave empty for vault root.",
        },
        recursive: {
          type: "string",
          enum: ["true", "false"],
          description:
            "'true' to list nested folders/files recursively (default 'true'), 'false' for direct children only.",
        },
        limit: {
          type: "string",
          description: "Maximum number of entries to return (default 100).",
        },
      },
    },
  },
  {
    name: "list_notes",
    description:
      "List markdown note paths in the vault or within a specific folder.",
    parameters: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description:
            "Optional folder path to list notes from (e.g. 'Work/Projects'). Leave empty for vault root.",
        },
        limit: {
          type: "string",
          description: "Maximum number of notes to return (default 50).",
        },
      },
    },
  },
  {
    name: "read_note",
    description:
      "Read the complete content of any note or text file in the Obsidian vault.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path or note title (e.g. 'Daily Notes/2026-11-11.md' or 'Ideas/Project').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_notes",
    description:
      "Read multiple notes or text files in a single batch call (up to 15 notes). Prefer this over repeated single read_note calls when inspecting multiple notes to save API calls and tool steps.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of relative note paths or note titles (e.g. ['Ideas/Project.md', 'Work/Roadmap.md']).",
        },
      },
      required: ["paths"],
    },
  },

  // ==========================================
  // Note Operations: Create, Edit, Move, Delete
  // ==========================================
  {
    name: "create_note",
    description:
      "Create a new markdown note (or text file) in the vault with the specified content. Automatically creates any missing parent folders.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path for the new note (e.g. 'Summaries/Meeting-Notes.md').",
        },
        content: {
          type: "string",
          description: "Markdown text content of the note.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_to_note",
    description:
      "Append markdown content to the end of an existing note in the vault.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path or title of the note to append to.",
        },
        content: {
          type: "string",
          description: "Markdown content to append.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "patch_note",
    description:
      "Surgically edit a specific section of an existing note by replacing exact matching text with new text, without having to rewrite the entire file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path or title of the note to patch.",
        },
        search_text: {
          type: "string",
          description:
            "Exact existing text snippet in the note to locate and replace (include enough context so it matches uniquely).",
        },
        replace_text: {
          type: "string",
          description:
            "Replacement markdown text. Pass empty string '' to delete the matched snippet.",
        },
      },
      required: ["path", "search_text", "replace_text"],
    },
  },
  {
    name: "replace_note_content",
    description:
      "Completely overwrite an existing note's entire content with new markdown.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path or title of the note to overwrite.",
        },
        content: {
          type: "string",
          description: "Complete replacement markdown content.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "rename_or_move_note",
    description:
      "Rename a note/file or move it into a different folder. Automatically updates all [[wikilinks]] across the vault and creates missing target folders.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Current path or title of the note/file to move or rename.",
        },
        new_path: {
          type: "string",
          description:
            "Destination relative path in the vault (e.g. 'Archive/2026/Old Note.md').",
        },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "delete_note",
    description:
      "Delete a note or file from the vault (moves it to Obsidian trash; revertible via chat Undo).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Exact relative path or unambiguous title of the note/file to delete.",
        },
      },
      required: ["path"],
    },
  },

  // ==========================================
  // Folder Operations: Create, Rename/Move, Delete
  // ==========================================
  {
    name: "create_folder",
    description:
      "Create a new folder (and any missing parent folders) in the Obsidian vault.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative folder path to create (e.g. 'Projects/2026/Q4').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_or_move_folder",
    description:
      "Rename or move an entire folder and all of its nested notes/subfolders to a new location in the vault, updating internal [[wikilinks]] automatically.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Current relative folder path (e.g. 'Inbox/Drafts').",
        },
        new_path: {
          type: "string",
          description: "New destination folder path (e.g. 'Projects/Drafts').",
        },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "delete_folder",
    description:
      "Delete a folder (empty or with its contents) from the vault by moving it to Obsidian trash. A snapshot is preserved so it can be reverted via Undo.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Exact relative path of the folder to delete (cannot be vault root).",
        },
      },
      required: ["path"],
    },
  },

  // ==========================================
  // Direct Workspace & Active Editor Operations
  // ==========================================
  {
    name: "get_active_note",
    description:
      "Get the title, path, cursor line, current text selection, and full content of the currently active note in the Obsidian workspace.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_workspace_state",
    description:
      "Inspect all open tabs/panes in the Obsidian workspace, showing open notes, active tab, cursor line, and selected text.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "open_note_in_workspace",
    description:
      "Open a note or file directly inside Obsidian's workspace in the current tab, a new tab, or a split pane.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path or title of the note/file to open.",
        },
        open_mode: {
          type: "string",
          enum: ["current", "new_tab", "split_right", "split_down"],
          description:
            "Where to open the note in the workspace (default 'new_tab').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "close_workspace_tab",
    description:
      "Close an open workspace tab corresponding to a specific note path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path or title of the open note whose tab should be closed.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_active_editor",
    description:
      "Make a direct live edit inside the currently active Markdown editor tab in Obsidian's workspace (replace selected text, insert at cursor, replace specific lines, or replace all content).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "replace_selection",
            "insert_at_cursor",
            "replace_lines",
            "replace_all",
          ],
          description:
            "'replace_selection' replaces highlighted text; 'insert_at_cursor' inserts at cursor; 'replace_lines' replaces lines start_line through end_line (1-based inclusive); 'replace_all' updates the entire active note.",
        },
        content: {
          type: "string",
          description: "Markdown text to insert or replace into the active editor.",
        },
        start_line: {
          type: "string",
          description:
            "Required only for 'replace_lines': 1-based starting line number.",
        },
        end_line: {
          type: "string",
          description:
            "Optional for 'replace_lines': 1-based ending line number (inclusive, defaults to start_line).",
        },
      },
      required: ["action", "content"],
    },
  },

  // ==========================================
  // Graph View & Knowledge Graph Tools
  // ==========================================
  {
    name: "open_graph_view",
    description:
      "Open Obsidian's visual Graph View tab in the workspace to visually inspect the note network.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["global", "local"],
          description:
            "'global' opens the full vault graph; 'local' opens the local graph for the active note.",
        },
      },
    },
  },
  {
    name: "get_graph_neighborhood",
    description:
      "Analyze the graph connections around a specific note: lists all outgoing links (forward links) and incoming links (backlinks) that connect to it.",
    parameters: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description:
            "The note title or relative path to inspect in the graph (e.g. 'Machine Learning' or 'Projects/Alpha.md').",
        },
      },
      required: ["note"],
    },
  },
  {
    name: "get_graph_analytics",
    description:
      "Get global statistics and insights about the vault's graph topology: total nodes, total link edges, top 'Hub' notes with the most connections, orphan/isolated notes with 0 connections, and top uncreated/unresolved links.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "find_graph_path",
    description:
      "Find the shortest chain of linked notes connecting two concepts/notes in the knowledge graph (e.g. Note A -> Note X -> Note B).",
    parameters: {
      type: "object",
      properties: {
        from_note: {
          type: "string",
          description: "Starting note title or path.",
        },
        to_note: {
          type: "string",
          description: "Destination note title or path.",
        },
      },
      required: ["from_note", "to_note"],
    },
  },
  {
    name: "connect_notes_in_graph",
    description:
      "Create an edge in the graph between two notes by adding a [[wikilink]] to source_note pointing to target_note.",
    parameters: {
      type: "object",
      properties: {
        source_note: {
          type: "string",
          description: "The note where the link should be added.",
        },
        target_note: {
          type: "string",
          description: "The note to link to (creates a graph connection).",
        },
        context_sentence: {
          type: "string",
          description:
            "Optional sentence explaining the connection to include alongside the link.",
        },
      },
      required: ["source_note", "target_note"],
    },
  },
];

export class VaultToolExecutor {
  private turnChanges: NoteChangeRecord[] = [];

  constructor(private app: App) {}

  public beginTurn(): void {
    this.turnChanges = [];
  }

  public getTurnChanges(): NoteChangeRecord[] {
    return [...this.turnChanges];
  }

  public getAndClearTurnChanges(): NoteChangeRecord[] {
    const list = [...this.turnChanges];
    this.turnChanges = [];
    return list;
  }

  private recordChange(
    record: Omit<NoteChangeRecord, "timestamp" | "id">
  ): void {
    const normPath = normalizePath(record.path);
    const kind = record.itemKind || "note";

    // Coalesce sequential modifications on the same note when uninterrupted by rename/delete
    if (record.type === "modified") {
      for (let i = this.turnChanges.length - 1; i >= 0; i--) {
        const prev = this.turnChanges[i];
        const prevKind = prev.itemKind || "note";
        if (prev.path === normPath || prev.previousPath === normPath) {
          if (
            prevKind === kind &&
            prev.path === normPath &&
            (prev.type === "created" || prev.type === "modified")
          ) {
            prev.newContent = record.newContent ?? prev.newContent;
            prev.timestamp = Date.now();
            return;
          }
          break;
        }
      }
    }

    this.turnChanges.push({
      ...record,
      id: `chg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      path: normPath,
      previousPath: record.previousPath
        ? normalizePath(record.previousPath)
        : undefined,
      reverted: false,
      timestamp: Date.now(),
    });
  }

  private async trashAbstractFile(item: TAbstractFile): Promise<void> {
    if (typeof this.app.fileManager?.trashFile === "function") {
      await this.app.fileManager.trashFile(item);
    } else {
      await this.app.vault.trash(item, true);
    }
  }

  private trySaveFileRecoverySnapshot(filePath: string, content: string): void {
    try {
      const frPlugin = (this.app as any).internalPlugins?.plugins?.[
        "file-recovery"
      ];
      const instance = frPlugin?.instance;
      if (instance && typeof instance.forceAdd === "function") {
        instance.forceAdd(filePath, content);
      }
    } catch {
      // File Recovery integration is best-effort
    }
  }

  public async readLiveText(file: TFile): Promise<string> {
    let liveFromEditor: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (liveFromEditor !== null || this.isSidepanelLeaf(leaf)) return;
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        liveFromEditor = leaf.view.editor.getValue();
      }
    });
    if (liveFromEditor !== null) {
      return liveFromEditor;
    }
    return await this.app.vault.read(file);
  }

  /**
   * Immediately synchronizes in-memory MarkdownView editors across all open workspace
   * tabs for this file. This ensures the user instantly sees modifications on screen,
   * cursor position is preserved, and Obsidian's autosave won't overwrite the disk
   * with stale in-memory buffers.
   */
  public syncOpenMarkdownViews(filePath: string, updatedContent: string): void {
    const cleanTarget = normalizePath(filePath);
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (this.isSidepanelLeaf(leaf)) return;
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.file?.path === cleanTarget
      ) {
        const editor = leaf.view.editor;
        if (editor) {
          const current = editor.getValue();
          if (current !== updatedContent) {
            const cursor = editor.getCursor();
            const scroll = editor.getScrollInfo();
            editor.setValue(updatedContent);
            try {
              editor.setCursor(cursor);
              editor.scrollTo(scroll.left, scroll.top);
            } catch {}
          }
        }
        try {
          if (typeof (leaf.view as any).data === "string") {
            (leaf.view as any).data = updatedContent;
          }
          leaf.view.setViewData?.(updatedContent, false);
          (leaf.view as any).clearDirty?.();
        } catch {}
      }
    });
  }

  /**
   * Inspects recorded changes against live vault/editor state to detect post-turn conflicts
   * and compute line-by-line diffs before presenting the confirmation popup.
   */
  public async inspectChangesForRevert(
    changes: NoteChangeRecord[]
  ): Promise<RevertInspectionItem[]> {
    const items: RevertInspectionItem[] = [];

    for (const record of changes) {
      const exactPath = normalizePath(record.path);
      const isFolder = record.itemKind === "folder";
      let hasConflict = false;
      let conflictReason: string | undefined;
      let diff: DiffResult | undefined;
      let isDiffable = false;

      if (isFolder) {
        const existing = this.app.vault.getAbstractFileByPath(exactPath);
        if (record.type === "created") {
          if (existing instanceof TFolder && existing.children.length > 0) {
            hasConflict = true;
            conflictReason =
              "Folder currently contains items; it will only be removed if emptied by other reverts.";
          } else if (!existing) {
            hasConflict = true;
            conflictReason = "Folder was already deleted or moved.";
          }
        } else if (record.type === "deleted") {
          if (existing) {
            hasConflict = true;
            conflictReason =
              "An item already exists at this folder path; restoring will merge/overwrite matching files.";
          }
        } else if (record.type === "renamed" && record.previousPath) {
          if (!(existing instanceof TFolder)) {
            hasConflict = true;
            conflictReason = "Moved folder is no longer at its destination path.";
          } else if (
            this.app.vault.getAbstractFileByPath(normalizePath(record.previousPath))
          ) {
            hasConflict = true;
            conflictReason = `Original path "${record.previousPath}" is already occupied.`;
          }
        }
        items.push({ record, hasConflict, conflictReason, isDiffable });
        continue;
      }

      // Note / file inspection
      const existing = this.app.vault.getAbstractFileByPath(exactPath);
      let currentText: string | null = null;
      const ext = exactPath.split(".").pop() || "md";

      if (existing instanceof TFile && isTextFileExtension(existing.extension)) {
        try {
          currentText = await this.readLiveText(existing);
        } catch {}
      }

      if (record.type === "modified") {
        if (!(existing instanceof TFile)) {
          hasConflict = true;
          conflictReason = "Note was deleted or moved after this AI turn.";
        } else if (
          currentText !== null &&
          record.newContent !== undefined &&
          record.newContent !== null &&
          currentText !== record.newContent
        ) {
          hasConflict = true;
          conflictReason =
            "You manually edited this note after the AI turn — reverting will overwrite your manual edits.";
        }
        if (record.previousContent !== null && isTextFileExtension(ext)) {
          isDiffable = true;
          diff = computeLineDiff(
            currentText ?? record.newContent ?? "",
            record.previousContent
          );
        }
      } else if (record.type === "created") {
        if (!(existing instanceof TFile)) {
          hasConflict = true;
          conflictReason = "Newly created file was already deleted or moved.";
        } else if (
          currentText !== null &&
          record.newContent !== undefined &&
          record.newContent !== null &&
          currentText !== record.newContent
        ) {
          hasConflict = true;
          conflictReason =
            "You edited this AI-created note afterwards — trashing it will discard your manual edits.";
        }
        const previewSource = currentText ?? record.newContent ?? null;
        if (previewSource !== null && isTextFileExtension(ext)) {
          isDiffable = true;
          diff = computeLineDiff(previewSource, "");
        }
      } else if (record.type === "deleted") {
        if (existing) {
          hasConflict = true;
          conflictReason =
            "A new file/folder now exists at this path — restoring will overwrite it.";
        }
        if (
          record.previousContent !== null &&
          record.previousContent !== undefined &&
          isTextFileExtension(ext)
        ) {
          isDiffable = true;
          diff = computeLineDiff(currentText ?? "", record.previousContent);
        }
      } else if (record.type === "renamed" && record.previousPath) {
        if (!(existing instanceof TFile)) {
          hasConflict = true;
          conflictReason = "Renamed file is no longer at its destination path.";
        } else if (
          this.app.vault.getAbstractFileByPath(normalizePath(record.previousPath))
        ) {
          hasConflict = true;
          conflictReason = `Original path "${record.previousPath}" already exists.`;
        }
      }

      items.push({ record, hasConflict, conflictReason, diff, isDiffable });
    }

    return items;
  }

  /**
   * Reverts selected note and folder changes strictly in reverse chronological order (LIFO),
   * preserving Redo snapshots and native File Recovery backups.
   */
  public async revertChanges(changes: NoteChangeRecord[]): Promise<string[]> {
    const revertedItems: string[] = [];
    const list = [...changes].reverse();

    for (const record of list) {
      try {
        const isFolder = record.itemKind === "folder";
        const exactPath = normalizePath(record.path);

        if (isFolder) {
          if (record.type === "created") {
            const folder = this.app.vault.getAbstractFileByPath(exactPath);
            if (folder instanceof TFolder) {
              if (folder.children.length === 0) {
                await this.trashAbstractFile(folder);
                record.reverted = true;
                revertedItems.push(`Removed created folder 📁 ${exactPath}`);
              } else {
                revertedItems.push(
                  `Kept non-empty folder 📁 ${exactPath} (contains extra files)`
                );
              }
            } else {
              record.reverted = true;
            }
          } else if (record.type === "renamed" && record.previousPath) {
            const currentFolder =
              this.app.vault.getAbstractFileByPath(exactPath);
            const targetPrevPath = normalizePath(record.previousPath);
            if (currentFolder instanceof TFolder) {
              const conflict =
                this.app.vault.getAbstractFileByPath(targetPrevPath);
              if (!conflict) {
                await this.ensureDirectoryExists(targetPrevPath, false, false);
                await this.app.fileManager.renameFile(
                  currentFolder,
                  targetPrevPath
                );
                record.reverted = true;
                revertedItems.push(
                  `Moved folder back: 📁 ${exactPath} → 📁 ${targetPrevPath}`
                );
              } else {
                revertedItems.push(
                  `Skipped moving 📁 ${exactPath} back (destination ${targetPrevPath} exists)`
                );
              }
            }
          } else if (record.type === "deleted") {
            await this.ensureDirectoryExists(exactPath, true, false);
            const snapshot = record.folderSnapshot || [];
            const folders = snapshot
              .filter((s) => s.isFolder)
              .sort(
                (a, b) =>
                  a.path.split("/").length - b.path.split("/").length
              );
            const files = snapshot.filter((s) => !s.isFolder);

            for (const sub of folders) {
              await this.ensureDirectoryExists(sub.path, true, false);
            }

            let restoredFiles = 0;
            for (const f of files) {
              const cleanFilePath = normalizePath(f.path);
              await this.ensureDirectoryExists(cleanFilePath, false, false);
              const existing =
                this.app.vault.getAbstractFileByPath(cleanFilePath);
              if (f.content !== undefined && f.content !== null) {
                if (existing instanceof TFile) {
                  const pre = await this.readLiveText(existing);
                  this.trySaveFileRecoverySnapshot(cleanFilePath, pre);
                  await this.app.vault.modify(existing, f.content);
                } else if (!existing) {
                  await this.app.vault.create(cleanFilePath, f.content);
                }
                restoredFiles++;
              } else if (f.binaryBase64) {
                const buf = base64ToArrayBuffer(f.binaryBase64);
                if (existing instanceof TFile) {
                  await this.app.vault.modifyBinary(existing, buf);
                } else if (!existing) {
                  await this.app.vault.createBinary(cleanFilePath, buf);
                }
                restoredFiles++;
              }
            }
            record.reverted = true;
            revertedItems.push(
              `Restored deleted folder 📁 ${exactPath} (${restoredFiles} file(s))`
            );
          }
          continue;
        }

        // Note / file reversion
        const existingAbstract =
          this.app.vault.getAbstractFileByPath(exactPath);

        if (record.type === "created" && record.previousContent === null) {
          if (existingAbstract instanceof TFile) {
            await this.flushOpenViewForFile(exactPath);
            if (isTextFileExtension(existingAbstract.extension)) {
              const current = await this.app.vault.read(existingAbstract);
              record.redoContent = current;
              this.trySaveFileRecoverySnapshot(exactPath, current);
            } else if (existingAbstract.stat.size <= MAX_BINARY_SNAPSHOT_BYTES) {
              const buf = await this.app.vault.readBinary(existingAbstract);
              record.redoBinaryBase64 = arrayBufferToBase64(buf);
            }
            await this.trashAbstractFile(existingAbstract);
            record.reverted = true;
            revertedItems.push(`Removed created note [[${exactPath}]]`);
          } else {
            record.reverted = true;
          }
        } else if (record.type === "modified" && record.previousContent !== null) {
          if (existingAbstract instanceof TFile) {
            await this.flushOpenViewForFile(exactPath);
            const current = await this.app.vault.read(existingAbstract);
            record.redoContent = current;
            this.trySaveFileRecoverySnapshot(exactPath, current);
            await this.app.vault.modify(
              existingAbstract,
              record.previousContent
            );
            this.syncOpenMarkdownViews(exactPath, record.previousContent);
            record.reverted = true;
            revertedItems.push(`Restored content of [[${exactPath}]]`);
          } else if (!existingAbstract) {
            await this.ensureDirectoryExists(exactPath, false, false);
            await this.app.vault.create(exactPath, record.previousContent);
            record.reverted = true;
            revertedItems.push(`Recreated content of [[${exactPath}]]`);
          }
        } else if (record.type === "renamed" && record.previousPath) {
          const targetPrevPath = normalizePath(record.previousPath);
          if (existingAbstract instanceof TFile) {
            const conflict =
              this.app.vault.getAbstractFileByPath(targetPrevPath);
            if (!conflict) {
              await this.flushOpenViewForFile(exactPath);
              await this.ensureDirectoryExists(targetPrevPath, false, false);
              await this.app.fileManager.renameFile(
                existingAbstract,
                targetPrevPath
              );
              record.reverted = true;
              revertedItems.push(
                `Moved note back: [[${exactPath}]] → [[${targetPrevPath}]]`
              );
            } else {
              revertedItems.push(
                `Skipped moving [[${exactPath}]] back (destination ${targetPrevPath} exists)`
              );
            }
          }
        } else if (record.type === "deleted") {
          await this.ensureDirectoryExists(exactPath, false, false);
          if (
            record.previousContent !== undefined &&
            record.previousContent !== null
          ) {
            if (existingAbstract instanceof TFile) {
              await this.flushOpenViewForFile(exactPath);
              const current = await this.app.vault.read(existingAbstract);
              record.redoContent = current;
              this.trySaveFileRecoverySnapshot(exactPath, current);
              await this.app.vault.modify(
                existingAbstract,
                record.previousContent
              );
              this.syncOpenMarkdownViews(exactPath, record.previousContent);
            } else if (!existingAbstract) {
              await this.app.vault.create(exactPath, record.previousContent);
            }
            record.reverted = true;
            revertedItems.push(`Restored deleted note [[${exactPath}]]`);
          } else if (record.previousBinaryBase64) {
            const buf = base64ToArrayBuffer(record.previousBinaryBase64);
            if (existingAbstract instanceof TFile) {
              await this.app.vault.modifyBinary(existingAbstract, buf);
            } else if (!existingAbstract) {
              await this.app.vault.createBinary(exactPath, buf);
            }
            record.reverted = true;
            revertedItems.push(`Restored deleted file [[${exactPath}]]`);
          }
        }
      } catch (err: any) {
        console.error(`Failed to revert change for ${record.path}:`, err);
        revertedItems.push(
          `Failed to revert ${record.path}: ${err?.message || String(err)}`
        );
      }
    }

    return revertedItems;
  }

  /**
   * Re-applies previously reverted changes in forward chronological order (Redo).
   */
  public async reapplyChanges(changes: NoteChangeRecord[]): Promise<string[]> {
    const reapplied: string[] = [];

    for (const record of changes) {
      if (!record.reverted) continue;
      try {
        const isFolder = record.itemKind === "folder";
        const exactPath = normalizePath(record.path);

        if (isFolder) {
          if (record.type === "created") {
            await this.ensureDirectoryExists(exactPath, true, false);
            record.reverted = false;
            reapplied.push(`Recreated folder 📁 ${exactPath}`);
          } else if (record.type === "renamed" && record.previousPath) {
            const prevFolder = this.app.vault.getAbstractFileByPath(
              normalizePath(record.previousPath)
            );
            if (
              prevFolder instanceof TFolder &&
              !this.app.vault.getAbstractFileByPath(exactPath)
            ) {
              await this.ensureDirectoryExists(exactPath, false, false);
              await this.app.fileManager.renameFile(prevFolder, exactPath);
              record.reverted = false;
              reapplied.push(
                `Moved folder forward: 📁 ${record.previousPath} → 📁 ${exactPath}`
              );
            }
          } else if (record.type === "deleted") {
            const folder = this.app.vault.getAbstractFileByPath(exactPath);
            if (folder instanceof TFolder) {
              await this.trashAbstractFile(folder);
              record.reverted = false;
              reapplied.push(`Re-deleted folder 📁 ${exactPath}`);
            }
          }
          continue;
        }

        // Note / file redo
        if (record.type === "created") {
          await this.ensureDirectoryExists(exactPath, false, false);
          const existing = this.app.vault.getAbstractFileByPath(exactPath);
          const targetContent = record.redoContent ?? record.newContent;
          if (targetContent !== undefined && targetContent !== null) {
            if (existing instanceof TFile) {
              await this.app.vault.modify(existing, targetContent);
              this.syncOpenMarkdownViews(exactPath, targetContent);
            } else if (!existing) {
              await this.app.vault.create(exactPath, targetContent);
            }
            record.reverted = false;
            reapplied.push(`Re-created note [[${exactPath}]]`);
          } else if (record.redoBinaryBase64) {
            const buf = base64ToArrayBuffer(record.redoBinaryBase64);
            if (existing instanceof TFile) {
              await this.app.vault.modifyBinary(existing, buf);
            } else if (!existing) {
              await this.app.vault.createBinary(exactPath, buf);
            }
            record.reverted = false;
            reapplied.push(`Re-created file [[${exactPath}]]`);
          }
        } else if (record.type === "modified") {
          const targetContent = record.redoContent ?? record.newContent;
          if (targetContent !== undefined && targetContent !== null) {
            const existing = this.app.vault.getAbstractFileByPath(exactPath);
            if (existing instanceof TFile) {
              await this.flushOpenViewForFile(exactPath);
              const pre = await this.app.vault.read(existing);
              this.trySaveFileRecoverySnapshot(exactPath, pre);
              await this.app.vault.modify(existing, targetContent);
              this.syncOpenMarkdownViews(exactPath, targetContent);
              record.reverted = false;
              reapplied.push(`Re-applied edits to [[${exactPath}]]`);
            }
          }
        } else if (record.type === "renamed" && record.previousPath) {
          const prevFile = this.app.vault.getAbstractFileByPath(
            normalizePath(record.previousPath)
          );
          if (
            prevFile instanceof TFile &&
            !this.app.vault.getAbstractFileByPath(exactPath)
          ) {
            await this.flushOpenViewForFile(prevFile.path);
            await this.ensureDirectoryExists(exactPath, false, false);
            await this.app.fileManager.renameFile(prevFile, exactPath);
            record.reverted = false;
            reapplied.push(
              `Moved note forward: [[${record.previousPath}]] → [[${exactPath}]]`
            );
          }
        } else if (record.type === "deleted") {
          const existing = this.app.vault.getAbstractFileByPath(exactPath);
          if (existing instanceof TFile) {
            await this.flushOpenViewForFile(exactPath);
            await this.trashAbstractFile(existing);
            record.reverted = false;
            reapplied.push(`Re-deleted [[${exactPath}]]`);
          }
        }
      } catch (err: any) {
        console.error(`Failed to re-apply change for ${record.path}:`, err);
        reapplied.push(
          `Failed to re-apply ${record.path}: ${err?.message || String(err)}`
        );
      }
    }

    return reapplied;
  }

  public async executeTool(
    name: string,
    argsJson: string,
    onStatus?: (status: string) => void
  ): Promise<string> {
    let args: any = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      return `Error: Failed to parse tool arguments as JSON: ${argsJson}`;
    }

    try {
      switch (name) {
        case "search_vault":
          onStatus?.(`Searching vault for "${args.query}"...`);
          return await this.searchVault(args.query);

        case "list_folders_and_files":
          onStatus?.(`Inspecting vault folders & files...`);
          return await this.listFoldersAndFiles(
            args.folder,
            String(args.recursive).toLowerCase() !== "false",
            parseInt(args.limit, 10) || 100
          );

        case "list_notes":
          onStatus?.(`Listing notes in ${args.folder || "vault"}...`);
          return await this.listNotes(args.folder, parseInt(args.limit, 10) || 50);

        case "read_note":
          onStatus?.(`Reading "${args.path}"...`);
          return await this.readNote(args.path);

        case "read_notes":
          onStatus?.(`Reading batch of notes...`);
          return await this.readNotes(args.paths ?? args.path);

        case "create_note":
          onStatus?.(`Creating note "${args.path}"...`);
          return await this.createNote(args.path, args.content);

        case "append_to_note":
          onStatus?.(`Appending to "${args.path}"...`);
          return await this.appendToNote(args.path, args.content);

        case "patch_note":
          onStatus?.(`Patching section in "${args.path}"...`);
          return await this.patchNote(
            args.path,
            args.search_text,
            args.replace_text
          );

        case "replace_note_content":
          onStatus?.(`Updating note "${args.path}"...`);
          return await this.replaceNoteContent(args.path, args.content);

        case "rename_or_move_note":
          onStatus?.(`Moving/renaming "${args.path}" → "${args.new_path}"...`);
          return await this.renameOrMoveNote(args.path, args.new_path);

        case "delete_note":
          onStatus?.(`Deleting note "${args.path}"...`);
          return await this.deleteNote(args.path);

        case "create_folder":
          onStatus?.(`Creating folder "${args.path}"...`);
          return await this.createFolder(args.path);

        case "rename_or_move_folder":
          onStatus?.(`Moving/renaming folder "${args.path}"...`);
          return await this.renameOrMoveFolder(args.path, args.new_path);

        case "delete_folder":
          onStatus?.(`Deleting folder "${args.path}"...`);
          return await this.deleteFolder(args.path);

        case "get_active_note":
          onStatus?.(`Reading active note...`);
          return await this.getActiveNote();

        case "get_workspace_state":
          onStatus?.(`Inspecting workspace tabs & editor...`);
          return await this.getWorkspaceState();

        case "open_note_in_workspace":
          onStatus?.(`Opening "${args.path}" in workspace...`);
          return await this.openNoteInWorkspace(args.path, args.open_mode);

        case "close_workspace_tab":
          onStatus?.(`Closing tab for "${args.path}"...`);
          return await this.closeWorkspaceTab(args.path);

        case "edit_active_editor":
          onStatus?.(`Editing active workspace editor...`);
          return await this.editActiveEditor(
            args.action,
            args.content,
            args.start_line ? parseInt(args.start_line, 10) : undefined,
            args.end_line ? parseInt(args.end_line, 10) : undefined
          );

        case "open_graph_view":
          onStatus?.(`Opening Obsidian Graph View...`);
          return await this.openGraphView(args.mode || "global");

        case "get_graph_neighborhood":
          onStatus?.(`Analyzing graph connections for "${args.note}"...`);
          return await this.getGraphNeighborhood(args.note);

        case "get_graph_analytics":
          onStatus?.(`Analyzing vault graph topology & hubs...`);
          return await this.getGraphAnalytics();

        case "find_graph_path":
          onStatus?.(
            `Finding graph path from "${args.from_note}" to "${args.to_note}"...`
          );
          return await this.findGraphPath(args.from_note, args.to_note);

        case "connect_notes_in_graph":
          onStatus?.(
            `Connecting [[${args.source_note}]] -> [[${args.target_note}]] in graph...`
          );
          return await this.connectNotesInGraph(
            args.source_note,
            args.target_note,
            args.context_sentence
          );

        default:
          return `Error: Unknown tool "${name}"`;
      }
    } catch (err: any) {
      return `Error executing ${name}: ${err?.message || String(err)}`;
    }
  }

  // ==========================================
  // Path Resolution & Helpers
  // ==========================================

  private resolveAnyFile(
    inputPath: string,
    failOnAmbiguous: boolean = false
  ): { file: TFile | null; error?: string } {
    const rawClean = (inputPath || "").trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
    const lower = rawClean.toLowerCase();

    // 0. Active note alias support: "active", "current", "this", "this note", "active note", or empty string
    if (
      !rawClean ||
      lower === "active" ||
      lower === "current" ||
      lower === "active_note" ||
      lower === "active note" ||
      lower === "this" ||
      lower === "this note"
    ) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        return { file: activeFile };
      }
      if (!rawClean) {
        return { file: null, error: "Empty file path provided and no active note is open." };
      }
    }

    const normalizedExact = normalizePath(rawClean);

    // 1. Exact path match as-is (works for both .md and non-.md files)
    const exactMatch = this.app.vault.getAbstractFileByPath(normalizedExact);
    if (exactMatch instanceof TFile) {
      return { file: exactMatch };
    }

    // 2. Try appending .md if not already ending with .md
    if (!rawClean.toLowerCase().endsWith(".md")) {
      const normalizedMd = normalizePath(`${rawClean}.md`);
      const mdMatch = this.app.vault.getAbstractFileByPath(normalizedMd);
      if (mdMatch instanceof TFile) {
        return { file: mdMatch };
      }
    }

    // 3. Linkpath resolution (handles wikilinks)
    const linkTarget = rawClean.replace(/\.md$/i, "");
    const linkFile = this.app.metadataCache.getFirstLinkpathDest(linkTarget, "");
    if (linkFile instanceof TFile && !failOnAmbiguous) {
      return { file: linkFile };
    }

    // 4. Filename / basename lookup across vault
    const baseQuery = rawClean.split("/").pop()?.toLowerCase() || "";
    const allFiles = this.app.vault.getFiles();
    const matches = allFiles.filter((f) => {
      const nameLower = f.name.toLowerCase();
      const baseLower = f.basename.toLowerCase();
      return nameLower === baseQuery || `${baseLower}.md` === `${baseQuery}.md`;
    });

    if (matches.length === 1) {
      return { file: matches[0] };
    }

    if (matches.length > 1) {
      if (failOnAmbiguous) {
        const list = matches.map((m) => `[[${m.path}]]`).join(", ");
        return {
          file: null,
          error: `Ambiguous file reference "${inputPath}". Multiple files match: ${list}. Please specify the exact full path.`,
        };
      }
      return { file: linkFile instanceof TFile ? linkFile : matches[0] };
    }

    if (linkFile instanceof TFile) {
      return { file: linkFile };
    }

    return { file: null };
  }

  private resolveTFile(inputPath: string): TFile | null {
    return this.resolveAnyFile(inputPath, false).file;
  }

  private resolveTFolder(inputPath: string): TFolder | null {
    if (!inputPath || !inputPath.trim() || inputPath.trim() === "/") {
      return this.app.vault.getRoot();
    }
    const clean = normalizePath(inputPath.trim().replace(/\/+$/, ""));
    const exact = this.app.vault.getAbstractFileByPath(clean);
    if (exact instanceof TFolder) {
      return exact;
    }

    // Fallback case-insensitive match
    const allFolders = this.getAllFolders(this.app.vault.getRoot());
    const match = allFolders.find(
      (f) => f.path.toLowerCase() === clean.toLowerCase()
    );
    return match || null;
  }

  private getAllFolders(root: TFolder): TFolder[] {
    const folders: TFolder[] = [];
    for (const child of root.children) {
      if (child instanceof TFolder) {
        folders.push(child);
        folders.push(...this.getAllFolders(child));
      }
    }
    return folders;
  }

  private async ensureDirectoryExists(
    targetPath: string,
    isFolderPath: boolean = false,
    trackChanges: boolean = true
  ): Promise<void> {
    const clean = normalizePath(targetPath);
    if (!clean || clean === ".") return;

    const parts = clean.split("/").filter(Boolean);
    if (!isFolderPath) {
      parts.pop();
    }
    if (parts.length === 0) return;

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const normalized = normalizePath(current);
      const existing = this.app.vault.getAbstractFileByPath(normalized);
      if (!existing) {
        await this.app.vault.createFolder(normalized);
        if (trackChanges) {
          this.recordChange({
            itemKind: "folder",
            path: normalized,
            type: "created",
            previousContent: null,
          });
        }
      } else if (existing instanceof TFile) {
        throw new Error(
          `Cannot create folder "${normalized}" because a file already exists at that path.`
        );
      }
    }
  }

  private getActiveMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;

    const recent = this.app.workspace.getMostRecentLeaf(
      this.app.workspace.rootSplit
    );
    if (recent && recent.view instanceof MarkdownView) {
      return recent.view;
    }
    return null;
  }

  private isSidepanelLeaf(leaf: WorkspaceLeaf): boolean {
    const viewType = leaf.view?.getViewType?.() || "";
    return viewType === "obsidian-ai-sidepanel-view";
  }

  private async flushOpenViewForFile(filePath: string): Promise<void> {
    const cleanTarget = normalizePath(filePath);
    const pendingSaves: Promise<void>[] = [];
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (this.isSidepanelLeaf(leaf)) return;
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === cleanTarget) {
        pendingSaves.push(leaf.view.save().catch(() => {}));
      }
    });
    if (pendingSaves.length > 0) {
      await Promise.all(pendingSaves);
    }
  }

  // ==========================================
  // Discovery Implementations
  // ==========================================

  public async searchVault(query: string): Promise<string> {
    if (!query || !query.trim()) {
      return "Please provide a non-empty search query.";
    }

    const q = query.toLowerCase().trim();
    const matchedFolders = this.getAllFolders(this.app.vault.getRoot())
      .filter((f) => f.path.toLowerCase().includes(q))
      .slice(0, 10);

    const files = this.app.vault.getFiles();
    const results: Array<{ path: string; matchType: string; snippet?: string }> =
      [];

    for (const file of files) {
      if (results.length >= 18) break;

      const pathLower = file.path.toLowerCase();
      const nameLower = file.basename.toLowerCase();

      if (nameLower.includes(q) || pathLower.includes(q)) {
        results.push({
          path: file.path,
          matchType: "Title/Path match",
        });
        continue;
      }

      if (isTextFileExtension(file.extension)) {
        try {
          const content = await this.app.vault.cachedRead(file);
          const idx = content.toLowerCase().indexOf(q);
          if (idx !== -1) {
            const start = Math.max(0, idx - 60);
            const end = Math.min(content.length, idx + q.length + 80);
            const snippet =
              (start > 0 ? "..." : "") +
              content.substring(start, end).replace(/\n+/g, " ") +
              (end < content.length ? "..." : "");
            results.push({
              path: file.path,
              matchType: "Content match",
              snippet: snippet.trim(),
            });
          }
        } catch {}
      }
    }

    if (matchedFolders.length === 0 && results.length === 0) {
      return `No folders or files matched the query "${query}". Total files scanned: ${files.length}.`;
    }

    let out = "";
    if (matchedFolders.length > 0) {
      out += `Matching folder(s) (${matchedFolders.length}):\n`;
      for (const f of matchedFolders) {
        out += `- 📁 \`${f.path}\` (${f.children.length} direct item(s))\n`;
      }
      out += `\n`;
    }

    if (results.length > 0) {
      out += `Found ${results.length} matching note/file(s) for "${query}":\n\n`;
      for (const r of results) {
        out += `- **[[${r.path}]]** (${r.matchType})\n`;
        if (r.snippet) {
          out += `  > ${r.snippet}\n`;
        }
      }
    }

    out += `\nUse read_note or list_folders_and_files to inspect further.`;
    return out;
  }

  public async listFoldersAndFiles(
    folderPath?: string,
    recursive: boolean = true,
    limit: number = 100
  ): Promise<string> {
    const cleanRoot = folderPath?.trim() || "";
    const targetFolder = this.resolveTFolder(cleanRoot);
    if (!targetFolder) {
      return `Error: Folder not found at "${cleanRoot}".`;
    }

    const cap = Math.min(Math.max(1, limit), 300);
    const lines: string[] = [];

    const walk = (dir: TFolder, depth: number) => {
      if (lines.length >= cap) return;

      const sortedChildren = [...dir.children].sort((a, b) => {
        if (a instanceof TFolder && !(b instanceof TFolder)) return -1;
        if (!(a instanceof TFolder) && b instanceof TFolder) return 1;
        return a.name.localeCompare(b.name);
      });

      const indent = "  ".repeat(depth);
      for (const child of sortedChildren) {
        if (lines.length >= cap) break;
        if (child instanceof TFolder) {
          lines.push(
            `${indent}- 📁 **${child.path}/** (${child.children.length} item(s))`
          );
          if (recursive) {
            walk(child, depth + 1);
          }
        } else if (child instanceof TFile) {
          const icon = child.extension === "md" ? "📝" : "📄";
          lines.push(`${indent}- ${icon} [[${child.path}]]`);
        }
      }
    };

    walk(targetFolder, 0);

    const headerPath = targetFolder.path || "/";
    if (lines.length === 0) {
      return `Folder "${headerPath}" is currently empty.`;
    }

    return `Contents of \`${headerPath}\` (showing ${lines.length} entry/entries, recursive=${recursive}):\n\n${lines.join(
      "\n"
    )}`;
  }

  public async listNotes(folder?: string, limit: number = 50): Promise<string> {
    let files = this.app.vault.getMarkdownFiles();
    if (folder && folder.trim()) {
      const cleanFolder = normalizePath(folder.trim()).toLowerCase();
      files = files.filter((f) =>
        f.path.toLowerCase().startsWith(cleanFolder)
      );
    }

    const total = files.length;
    const subset = files.slice(0, Math.min(limit, 100));

    let output = `Total markdown notes found: ${total} (showing first ${subset.length}):\n`;
    for (const f of subset) {
      output += `- [[${f.path}]]\n`;
    }
    return output;
  }

  public async readNote(path: string): Promise<string> {
    const resolved = this.resolveAnyFile(path, false);
    if (!resolved.file) {
      return `Error: Note or file not found for path "${path}". Check the path or use search_vault / list_folders_and_files.`;
    }
    if (!isTextFileExtension(resolved.file.extension)) {
      return `File [[${resolved.file.path}]] is a binary file (.${resolved.file.extension}, ${resolved.file.stat.size} bytes) and cannot be read as markdown text.`;
    }
    await this.flushOpenViewForFile(resolved.file.path);
    const content = await this.readLiveText(resolved.file);
    return `Content of [[${resolved.file.path}]]:\n\n${content}`;
  }

  public async readNotes(pathsInput: unknown): Promise<string> {
    let rawList: string[] = [];
    if (Array.isArray(pathsInput)) {
      rawList = pathsInput.map((item) => String(item || "").trim()).filter(Boolean);
    } else if (typeof pathsInput === "string") {
      const trimmed = pathsInput.trim();
      if (trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            rawList = parsed.map((item) => String(item || "").trim()).filter(Boolean);
          }
        } catch {}
      }
      if (rawList.length === 0) {
        rawList = trimmed
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    if (rawList.length === 0) {
      return "Error: 'paths' must be a non-empty array of note paths.";
    }

    const maxBatch = 15;
    const truncatedCount = Math.max(0, rawList.length - maxBatch);
    const batch = rawList.slice(0, maxBatch);

    const sections: string[] = [];
    for (const p of batch) {
      sections.push(await this.readNote(p));
    }

    if (truncatedCount > 0) {
      sections.push(
        `[Notice: Capped batch at ${maxBatch} notes (${truncatedCount} additional path(s) omitted; call read_notes again for remaining paths).]`
      );
    }

    return sections.join("\n\n---\n\n");
  }

  // ==========================================
  // Note CRUD & Patch Implementations
  // ==========================================

  public async createNote(path: string, content: string): Promise<string> {
    let clean = path.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
    if (!/\.[a-z0-9]{1,8}$/i.test(clean)) {
      clean = `${clean}.md`;
    }
    const normalized = normalizePath(clean);

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      return `Error: File already exists at "${normalized}". Use append_to_note, patch_note, or replace_note_content instead.`;
    }

    await this.ensureDirectoryExists(normalized, false, true);
    const createdText = content ?? "";
    const newFile = await this.app.vault.create(normalized, createdText);
    this.recordChange({
      itemKind: "note",
      path: newFile.path,
      type: "created",
      previousContent: null,
      newContent: isTextFileExtension(newFile.extension) ? createdText : null,
    });
    return `Successfully created note: [[${newFile.path}]] (${createdText.length} characters).`;
  }

  public async appendToNote(path: string, content: string): Promise<string> {
    const file = this.resolveTFile(path);
    if (!file) {
      return `Error: Note not found at "${path}". Cannot append.`;
    }

    await this.flushOpenViewForFile(file.path);
    const currentContent = await this.readLiveText(file);
    const separator =
      currentContent.length === 0
        ? ""
        : currentContent.endsWith("\n")
        ? "\n"
        : "\n\n";
    const updated = currentContent + separator + content;
    await this.app.vault.modify(file, updated);
    this.syncOpenMarkdownViews(file.path, updated);
    this.recordChange({
      itemKind: "note",
      path: file.path,
      type: "modified",
      previousContent: currentContent,
      newContent: updated,
    });
    return `Successfully appended content to [[${file.path}]]. Note now has ${updated.length} characters.`;
  }

  public async patchNote(
    path: string,
    searchText: string,
    replaceText: string
  ): Promise<string> {
    const file = this.resolveTFile(path);
    if (!file) {
      return `Error: Note not found at "${path}". Cannot patch.`;
    }
    if (!searchText) {
      return `Error: search_text must be a non-empty string.`;
    }

    await this.flushOpenViewForFile(file.path);
    const currentContent = await this.readLiveText(file);
    const normalizedContent = currentContent.replace(/\r\n/g, "\n");
    const normalizedSearch = searchText.replace(/\r\n/g, "\n");
    const normalizedReplace = (replaceText ?? "").replace(/\r\n/g, "\n");

    let matchIdx = -1;
    let matchLen = 0;

    // Tier 1: Exact substring match
    const exactFirst = normalizedContent.indexOf(normalizedSearch);
    if (exactFirst !== -1) {
      const exactSecond = normalizedContent.indexOf(normalizedSearch, exactFirst + 1);
      if (exactSecond !== -1) {
        return `Error: Found multiple occurrences of search_text in [[${file.path}]]. Please include more surrounding context lines so the target snippet is unique.`;
      }
      matchIdx = exactFirst;
      matchLen = normalizedSearch.length;
    }

    // Tier 2: Whitespace-tolerant line matching if exact match was not found
    if (matchIdx === -1) {
      const contentLines = normalizedContent.split("\n");
      const searchLines = normalizedSearch.split("\n");

      const trimmedContentLines = contentLines.map((l) => l.trimEnd());
      const trimmedSearchLines = searchLines.map((l) => l.trimEnd());

      const foundIndices: number[] = [];
      const sLen = trimmedSearchLines.length;

      for (let i = 0; i <= trimmedContentLines.length - sLen; i++) {
        let matches = true;
        for (let j = 0; j < sLen; j++) {
          if (trimmedContentLines[i + j] !== trimmedSearchLines[j]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          foundIndices.push(i);
        }
      }

      if (foundIndices.length === 1) {
        const startLineIdx = foundIndices[0];
        const startOffset =
          contentLines.slice(0, startLineIdx).join("\n").length +
          (startLineIdx > 0 ? 1 : 0);
        const matchedLinesSlice = contentLines
          .slice(startLineIdx, startLineIdx + sLen)
          .join("\n");
        matchIdx = startOffset;
        matchLen = matchedLinesSlice.length;
      } else if (foundIndices.length > 1) {
        return `Error: Found ${foundIndices.length} occurrences of search_text in [[${file.path}]]. Include more surrounding context lines.`;
      }
    }

    // Tier 3: Smart quote & punctuation normalization
    if (matchIdx === -1) {
      const dequote = (s: string) =>
        s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      const dequotedContent = dequote(normalizedContent);
      const dequotedSearch = dequote(normalizedSearch);

      const dIdx = dequotedContent.indexOf(dequotedSearch);
      if (dIdx !== -1) {
        const dSecond = dequotedContent.indexOf(dequotedSearch, dIdx + 1);
        if (dSecond === -1) {
          matchIdx = dIdx;
          matchLen = dequotedSearch.length;
        }
      }
    }

    if (matchIdx === -1) {
      return `Error: search_text was not found in [[${file.path}]]. Make sure to read the note to verify exact wording, or use replace_note_content / edit_active_editor.`;
    }

    const updated =
      normalizedContent.slice(0, matchIdx) +
      normalizedReplace +
      normalizedContent.slice(matchIdx + matchLen);

    await this.app.vault.modify(file, updated);
    this.syncOpenMarkdownViews(file.path, updated);
    this.recordChange({
      itemKind: "note",
      path: file.path,
      type: "modified",
      previousContent: currentContent,
      newContent: updated,
    });
    return `Successfully patched [[${file.path}]]. Changes are now live in Obsidian.`;
  }

  public async replaceNoteContent(
    path: string,
    content: string
  ): Promise<string> {
    const file = this.resolveTFile(path);
    if (!file) {
      return `Error: Note not found at "${path}". Cannot replace.`;
    }
    await this.flushOpenViewForFile(file.path);
    const currentContent = await this.readLiveText(file);
    await this.app.vault.modify(file, content);
    this.syncOpenMarkdownViews(file.path, content);
    this.recordChange({
      itemKind: "note",
      path: file.path,
      type: "modified",
      previousContent: currentContent,
      newContent: content,
    });
    return `Successfully updated content of [[${file.path}]]. Changes are now live in Obsidian.`;
  }

  public async renameOrMoveNote(
    path: string,
    newPath: string
  ): Promise<string> {
    const resolved = this.resolveAnyFile(path, true);
    if (resolved.error) {
      return `Error: ${resolved.error}`;
    }
    const file = resolved.file;
    if (!file) {
      return `Error: Note or file not found at "${path}".`;
    }

    let cleanNew = newPath.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
    if (!/\.[a-z0-9]{1,8}$/i.test(cleanNew) && file.extension) {
      cleanNew = `${cleanNew}.${file.extension}`;
    }
    const normalizedNew = normalizePath(cleanNew);

    if (normalizedNew === file.path) {
      return `Note [[${file.path}]] is already at that exact path.`;
    }

    const conflict = this.app.vault.getAbstractFileByPath(normalizedNew);
    if (conflict) {
      return `Error: Destination path "${normalizedNew}" already exists.`;
    }

    const oldPath = file.path;
    await this.flushOpenViewForFile(oldPath);
    await this.ensureDirectoryExists(normalizedNew, false, true);
    await this.app.fileManager.renameFile(file, normalizedNew);

    this.recordChange({
      itemKind: "note",
      path: normalizedNew,
      previousPath: oldPath,
      type: "renamed",
      previousContent: null,
    });
    return `Successfully moved/renamed [[${oldPath}]] → [[${normalizedNew}]] (vault wikilinks updated).`;
  }

  public async deleteNote(path: string): Promise<string> {
    const resolved = this.resolveAnyFile(path, true);
    if (resolved.error) {
      return `Error: ${resolved.error}`;
    }
    const file = resolved.file;
    if (!file) {
      return `Error: Note or file not found at "${path}". Cannot delete.`;
    }

    const deletedPath = file.path;
    await this.flushOpenViewForFile(deletedPath);
    let previousContent: string | null = null;
    let previousBinaryBase64: string | undefined;

    if (isTextFileExtension(file.extension)) {
      previousContent = await this.app.vault.read(file);
    } else if (file.stat.size <= MAX_BINARY_SNAPSHOT_BYTES) {
      const buf = await this.app.vault.readBinary(file);
      previousBinaryBase64 = arrayBufferToBase64(buf);
    }

    await this.trashAbstractFile(file);

    this.recordChange({
      itemKind: "note",
      path: deletedPath,
      type: "deleted",
      previousContent,
      previousBinaryBase64,
    });
    return `Successfully deleted [[${deletedPath}]] (moved to Obsidian trash; revertible via Undo).`;
  }

  // ==========================================
  // Folder CRUD Implementations
  // ==========================================

  public async createFolder(path: string): Promise<string> {
    const normalized = normalizePath((path || "").trim().replace(/\/+$/, ""));
    if (!normalized || normalized === "/") {
      return "Error: Please specify a valid folder path.";
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) {
      return `Folder "${normalized}" already exists.`;
    }
    if (existing instanceof TFile) {
      return `Error: A file already exists at "${normalized}".`;
    }

    await this.ensureDirectoryExists(normalized, true, true);
    return `Successfully created folder 📁 "${normalized}".`;
  }

  public async renameOrMoveFolder(
    path: string,
    newPath: string
  ): Promise<string> {
    const folder = this.resolveTFolder(path);
    if (!folder || folder.isRoot()) {
      return `Error: Folder not found or cannot move vault root ("${path}").`;
    }

    const normalizedNew = normalizePath(
      (newPath || "").trim().replace(/\/+$/, "")
    );
    if (!normalizedNew || normalizedNew === "/") {
      return `Error: Invalid destination folder path "${newPath}".`;
    }

    if (normalizedNew === folder.path) {
      return `Folder 📁 "${folder.path}" is already at that location.`;
    }
    if (normalizedNew.toLowerCase().startsWith(`${folder.path.toLowerCase()}/`)) {
      return `Error: Cannot move folder "${folder.path}" inside itself ("${normalizedNew}").`;
    }

    const conflict = this.app.vault.getAbstractFileByPath(normalizedNew);
    if (conflict) {
      return `Error: Destination "${normalizedNew}" already exists.`;
    }

    const oldPath = folder.path;
    await this.ensureDirectoryExists(normalizedNew, false, true);
    await this.app.fileManager.renameFile(folder, normalizedNew);

    this.recordChange({
      itemKind: "folder",
      path: normalizedNew,
      previousPath: oldPath,
      type: "renamed",
      previousContent: null,
    });
    return `Successfully moved/renamed folder 📁 "${oldPath}" → 📁 "${normalizedNew}".`;
  }

  private async snapshotFolderRecursive(
    folder: TFolder,
    snapshot: DeletedVaultItemSnapshot[]
  ): Promise<void> {
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        snapshot.push({ path: child.path, isFolder: true });
        await this.snapshotFolderRecursive(child, snapshot);
      } else if (child instanceof TFile) {
        if (isTextFileExtension(child.extension)) {
          const content = await this.app.vault.read(child);
          snapshot.push({ path: child.path, isFolder: false, content });
        } else if (child.stat.size <= MAX_BINARY_SNAPSHOT_BYTES) {
          const buf = await this.app.vault.readBinary(child);
          snapshot.push({
            path: child.path,
            isFolder: false,
            content: null,
            binaryBase64: arrayBufferToBase64(buf),
          });
        } else {
          snapshot.push({ path: child.path, isFolder: false, content: null });
        }
      }
    }
  }

  public async deleteFolder(path: string): Promise<string> {
    const cleanInput = (path || "").trim().replace(/\/+$/, "");
    if (!cleanInput || cleanInput === "/") {
      return "Error: Refusing to delete vault root folder.";
    }

    const folder = this.resolveTFolder(cleanInput);
    if (!folder || folder.isRoot()) {
      return `Error: Folder not found at "${cleanInput}".`;
    }

    const deletedPath = folder.path;
    const snapshot: DeletedVaultItemSnapshot[] = [];
    await this.snapshotFolderRecursive(folder, snapshot);

    await this.trashAbstractFile(folder);

    this.recordChange({
      itemKind: "folder",
      path: deletedPath,
      type: "deleted",
      previousContent: null,
      folderSnapshot: snapshot,
    });

    const fileCount = snapshot.filter((s) => !s.isFolder).length;
    return `Successfully deleted folder 📁 "${deletedPath}" (${fileCount} nested file(s) snapshotted for Undo).`;
  }

  // ==========================================
  // Direct Workspace & Active Editor Tools
  // ==========================================

  public async getActiveNote(): Promise<string> {
    const view = this.getActiveMarkdownView();
    const activeFile = view?.file || this.app.workspace.getActiveFile();
    if (!activeFile) {
      return "No note is currently open in the active workspace editor.";
    }

    const content = view?.editor
      ? view.editor.getValue()
      : await this.app.vault.read(activeFile);
    let editorInfo = "";
    if (view && view.editor) {
      const cursor = view.editor.getCursor();
      const selection = view.editor.getSelection();
      editorInfo += `Cursor: Line ${cursor.line + 1}, Column ${cursor.ch + 1}\n`;
      if (selection) {
        editorInfo += `Selected Text:\n\`\`\`\n${selection}\n\`\`\`\n`;
      }
    }

    return `Active Note: [[${activeFile.path}]]\nTitle: ${activeFile.basename}\n${editorInfo}\nContent:\n${content}`;
  }

  public async getWorkspaceState(): Promise<string> {
    const openTabs: string[] = [];
    const activeView = this.getActiveMarkdownView();
    const activePath = activeView?.file?.path;

    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (this.isSidepanelLeaf(leaf)) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        const isCurrent = view.file.path === activePath;
        const cursor = view.editor?.getCursor();
        const selection = view.editor?.getSelection();
        let details = isCurrent ? "**[ACTIVE]** " : "";
        details += `[[${view.file.path}]]`;
        if (cursor) {
          details += ` (Line ${cursor.line + 1})`;
        }
        if (selection && isCurrent) {
          const preview =
            selection.length > 100
              ? `${selection.slice(0, 100)}...`
              : selection;
          details += ` — Selected: "${preview.replace(/\n/g, " ")}"`;
        }
        openTabs.push(`- ${details}`);
      } else {
        const fileView: any = view;
        if (fileView?.file instanceof TFile) {
          openTabs.push(
            `- 📄 [[${fileView.file.path}]] (${view.getViewType()})`
          );
        }
      }
    });

    if (openTabs.length === 0) {
      return "No note tabs are currently open in the main workspace.";
    }

    return `Open Workspace Tabs (${openTabs.length}):\n\n${openTabs.join(
      "\n"
    )}`;
  }

  public async openNoteInWorkspace(
    path: string,
    openMode: string = "new_tab"
  ): Promise<string> {
    const resolved = this.resolveAnyFile(path, false);
    if (!resolved.file) {
      return `Error: File not found at "${path}".`;
    }
    const file = resolved.file;

    if (openMode !== "split_right" && openMode !== "split_down" && openMode !== "current") {
      let existingLeaf: WorkspaceLeaf | null = null;
      this.app.workspace.iterateAllLeaves((l: WorkspaceLeaf) => {
        if (!existingLeaf && !this.isSidepanelLeaf(l)) {
          const v: any = l.view;
          if (v?.file?.path === file.path) {
            existingLeaf = l;
          }
        }
      });
      if (existingLeaf) {
        this.app.workspace.revealLeaf(existingLeaf);
        return `Focused existing workspace tab for [[${file.path}]].`;
      }
    }

    let leaf: WorkspaceLeaf | null = null;
    if (openMode === "split_right") {
      leaf = this.app.workspace.getLeaf("split", "vertical");
    } else if (openMode === "split_down") {
      leaf = this.app.workspace.getLeaf("split", "horizontal");
    } else if (openMode === "current") {
      const recent = this.app.workspace.getMostRecentLeaf(
        this.app.workspace.rootSplit
      );
      if (recent && !this.isSidepanelLeaf(recent)) {
        leaf = recent;
      } else {
        leaf = this.app.workspace.getLeaf("tab");
      }
    } else {
      leaf = this.app.workspace.getLeaf("tab");
    }

    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
    return `Opened [[${file.path}]] directly in workspace (${openMode || "new_tab"}).`;
  }

  public async closeWorkspaceTab(path: string): Promise<string> {
    const resolved = this.resolveAnyFile(path, false);
    if (!resolved.file) {
      return `Error: Note/file not found for "${path}".`;
    }
    const targetPath = resolved.file.path;

    let closedCount = 0;
    const toClose: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (this.isSidepanelLeaf(leaf)) return;
      const v: any = leaf.view;
      if (v?.file?.path === targetPath) {
        toClose.push(leaf);
      }
    });

    for (const leaf of toClose) {
      leaf.detach();
      closedCount++;
    }

    if (closedCount === 0) {
      return `No open workspace tab found for [[${targetPath}]].`;
    }
    return `Closed ${closedCount} workspace tab(s) for [[${targetPath}]].`;
  }

  public async editActiveEditor(
    action: string,
    content: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const view = this.getActiveMarkdownView();
    if (!view || !view.file || !view.editor) {
      return "Error: No active markdown editor found in the workspace. Open a note first using open_note_in_workspace.";
    }

    const editor = view.editor;
    const file = view.file;
    const previousContent = editor.getValue();

    if (action === "replace_selection") {
      const selection = editor.getSelection();
      if (!selection) {
        return `No text is currently selected in [[${file.path}]]. Use 'insert_at_cursor' or 'replace_lines' instead.`;
      }
      editor.replaceSelection(content);
      const updatedText = editor.getValue();
      await view.save().catch(() => {});
      this.recordChange({
        itemKind: "note",
        path: file.path,
        type: "modified",
        previousContent,
        newContent: updatedText,
      });
      return `Replaced highlighted selection in active editor [[${file.path}]].`;
    }

    if (action === "insert_at_cursor") {
      const cursor = editor.getCursor();
      editor.replaceRange(content, cursor);
      const updatedText = editor.getValue();
      await view.save().catch(() => {});
      this.recordChange({
        itemKind: "note",
        path: file.path,
        type: "modified",
        previousContent,
        newContent: updatedText,
      });
      return `Inserted content at cursor (Line ${cursor.line + 1}) in active editor [[${file.path}]].`;
    }

    if (action === "replace_lines") {
      const totalLines = editor.lineCount();
      if (!startLine || startLine < 1 || startLine > totalLines) {
        return `Error: Invalid start_line (${startLine}). Active note [[${file.path}]] has ${totalLines} lines.`;
      }
      const fromLineIdx = startLine - 1;
      const effectiveEnd = Math.min(
        totalLines,
        Math.max(startLine, endLine || startLine)
      );
      const toLineIdx = effectiveEnd - 1;
      const toCh = editor.getLine(toLineIdx).length;

      editor.replaceRange(
        content,
        { line: fromLineIdx, ch: 0 },
        { line: toLineIdx, ch: toCh }
      );
      const updatedText = editor.getValue();
      await view.save().catch(() => {});
      this.recordChange({
        itemKind: "note",
        path: file.path,
        type: "modified",
        previousContent,
        newContent: updatedText,
      });
      return `Replaced line(s) ${startLine}-${effectiveEnd} in active editor [[${file.path}]].`;
    }

    if (action === "replace_all" || action === "replace_content" || action === "overwrite") {
      editor.setValue(content);
      const updatedText = editor.getValue();
      await view.save().catch(() => {});
      this.recordChange({
        itemKind: "note",
        path: file.path,
        type: "modified",
        previousContent,
        newContent: updatedText,
      });
      return `Replaced entire content of active editor [[${file.path}]].`;
    }

    return `Error: Unsupported edit_active_editor action "${action}".`;
  }

  // ==========================================
  // Graph View & Link Graph Implementations
  // ==========================================

  /**
   * Builds a deterministic, real-time link graph directly from current note contents
   * (including unsaved open editor buffers), avoiding transient Obsidian metadataCache
   * re-indexing lag/bouncing right after vault edits.
   */
  private async buildLiveLinkGraph(): Promise<{
    allFiles: TFile[];
    outgoing: Map<string, Set<string>>;
    incoming: Map<string, Set<string>>;
    unresolvedCounts: Map<string, number>;
  }> {
    const allFiles = this.app.vault.getMarkdownFiles();
    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();
    const unresolvedCounts = new Map<string, number>();

    const byLowerPath = new Map<string, TFile>();
    const byLowerNoExt = new Map<string, TFile>();
    const byLowerBasename = new Map<string, TFile>();

    for (const f of allFiles) {
      outgoing.set(f.path, new Set<string>());
      incoming.set(f.path, new Set<string>());
      const lp = f.path.toLowerCase();
      byLowerPath.set(lp, f);
      byLowerNoExt.set(lp.replace(/\.md$/i, ""), f);
      const lb = f.basename.toLowerCase();
      if (!byLowerBasename.has(lb)) {
        byLowerBasename.set(lb, f);
      }
    }

    // Snapshot any open MarkdownView buffers once so unsaved edits are reflected immediately
    const openEditorBuffers = new Map<string, string>();
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (this.isSidepanelLeaf(leaf)) return;
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        openEditorBuffers.set(leaf.view.file.path, leaf.view.editor.getValue());
      }
    });

    const resolveTargetFile = (
      rawLinkTarget: string,
      sourcePath: string
    ): TFile | null => {
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        rawLinkTarget,
        sourcePath
      );
      if (dest && dest.extension === "md") {
        return dest;
      }
      const norm = normalizePath(rawLinkTarget).toLowerCase();
      const withoutExt = norm.replace(/\.md$/i, "");
      return (
        byLowerPath.get(norm) ||
        byLowerPath.get(`${withoutExt}.md`) ||
        byLowerNoExt.get(withoutExt) ||
        byLowerBasename.get(withoutExt) ||
        null
      );
    };

    const nonNoteExtRegex =
      /\.(png|jpe?g|gif|webp|svg|bmp|ico|pdf|mp3|wav|ogg|m4a|mp4|webm|mov|zip|csv|json|canvas)$/i;

    await Promise.all(
      allFiles.map(async (file) => {
        let text = openEditorBuffers.get(file.path);
        if (text === undefined) {
          text = await this.app.vault.cachedRead(file);
        }

        // Strip fenced code blocks and inline code so code examples don't create false edges
        const cleaned = text
          .replace(/```[\s\S]*?```/g, "")
          .replace(/~~~[\s\S]*?~~~/g, "")
          .replace(/`[^`\n]*`/g, "");

        const outSet = outgoing.get(file.path)!;

        // 1. Wikilinks: [[Target]], [[Target|Alias]], [[Target#Heading]]
        const wikiRegex = /!?\[\[([^\]\n]+)\]\]/g;
        let match: RegExpExecArray | null;
        while ((match = wikiRegex.exec(cleaned)) !== null) {
          const inner = match[1].split("|")[0].split("#")[0].trim();
          if (!inner) continue; // heading-only self-link [[#Section]]
          if (nonNoteExtRegex.test(inner)) continue;

          const targetFile = resolveTargetFile(inner, file.path);
          if (targetFile) {
            if (targetFile.path !== file.path) {
              outSet.add(targetFile.path);
              incoming.get(targetFile.path)?.add(file.path);
            }
          } else {
            unresolvedCounts.set(inner, (unresolvedCounts.get(inner) || 0) + 1);
          }
        }

        // 2. Markdown links: [Label](path/to/Note.md)
        const mdLinkRegex = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
        while ((match = mdLinkRegex.exec(cleaned)) !== null) {
          let href = match[1].trim();
          if (
            !href ||
            href.startsWith("#") ||
            /^[a-z][a-z0-9+.-]*:/i.test(href)
          ) {
            continue;
          }
          href = decodeURIComponent(href.split("#")[0].split("?")[0]).trim();
          if (!href || nonNoteExtRegex.test(href)) continue;

          const targetFile = resolveTargetFile(href, file.path);
          if (targetFile && targetFile.path !== file.path) {
            outSet.add(targetFile.path);
            incoming.get(targetFile.path)?.add(file.path);
          }
        }
      })
    );

    return { allFiles, outgoing, incoming, unresolvedCounts };
  }

  public async openGraphView(mode: string): Promise<string> {
    try {
      if (mode === "local") {
        // @ts-ignore
        this.app.commands.executeCommandById("graph:open-local");
        return "Opened Local Graph View in Obsidian for the active note.";
      } else {
        // @ts-ignore
        this.app.commands.executeCommandById("graph:open");
        return "Opened global Graph View in Obsidian.";
      }
    } catch (e: any) {
      return `Error opening graph view: ${e.message || String(e)}`;
    }
  }

  public async getGraphNeighborhood(noteName: string): Promise<string> {
    const file = this.resolveTFile(noteName);
    if (!file) {
      return `Error: Note "${noteName}" not found in vault.`;
    }

    const { outgoing: outgoingGraph, incoming: incomingGraph } =
      await this.buildLiveLinkGraph();
    const targetPath = file.path;

    const outgoing = Array.from(outgoingGraph.get(targetPath) || []).sort();
    const incoming = Array.from(incomingGraph.get(targetPath) || []).sort();

    let report = `### Graph Connections for [[${file.basename}]]\n\n`;
    report += `**Path in Vault:** \`${targetPath}\`\n`;
    report += `**Total Direct Graph Connections:** ${outgoing.length + incoming.length}\n\n`;

    report += `#### ➡️ Outgoing Links (Forward Links) [${outgoing.length}]:\n`;
    if (outgoing.length === 0) {
      report += `*(This note has no outgoing links)*\n`;
    } else {
      for (const out of outgoing) {
        report += `- [[${out}]]\n`;
      }
    }

    report += `\n#### ⬅️ Incoming Links (Backlinks) [${incoming.length}]:\n`;
    if (incoming.length === 0) {
      report += `*(No other notes currently link to this note)*\n`;
    } else {
      for (const inc of incoming) {
        report += `- [[${inc}]]\n`;
      }
    }

    return report;
  }

  public async getGraphAnalytics(): Promise<string> {
    const { allFiles, outgoing, incoming, unresolvedCounts } =
      await this.buildLiveLinkGraph();

    let totalLinks = 0;
    const connectionCounts: Record<
      string,
      { forward: number; back: number; total: number }
    > = {};

    for (const f of allFiles) {
      const forward = outgoing.get(f.path)?.size || 0;
      const back = incoming.get(f.path)?.size || 0;
      totalLinks += forward;
      connectionCounts[f.path] = {
        forward,
        back,
        total: forward + back,
      };
    }

    // Sort by total connections
    const sortedNodes = Object.entries(connectionCounts).sort(
      (a, b) => b[1].total - a[1].total
    );

    // Top Hubs
    const hubs = sortedNodes.filter((n) => n[1].total > 0).slice(0, 10);

    // Orphan notes (0 connections)
    const orphans = sortedNodes.filter((n) => n[1].total === 0).slice(0, 15);

    const topUnresolved = Array.from(unresolvedCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    let res = `### 🕸️ Obsidian Vault Graph Analytics\n\n`;
    res += `- **Total Notes (Nodes):** ${allFiles.length}\n`;
    res += `- **Total Connected Links (Edges):** ${totalLinks}\n`;
    res += `- **Average Connections per Note:** ${(
      totalLinks / Math.max(1, allFiles.length)
    ).toFixed(1)}\n\n`;

    res += `#### 🌟 Top Hub Notes (Most Connected):\n`;
    if (hubs.length === 0) {
      res += `*(No linked notes yet)*\n`;
    } else {
      for (const [path, c] of hubs) {
        res += `- **[[${path}]]**: ${c.total} connections (${c.back} backlinks, ${c.forward} outgoing)\n`;
      }
    }

    res += `\n#### 🏝️ Isolated / Orphan Notes (0 Links):\n`;
    if (orphans.length === 0) {
      res += `*Great job! All notes are connected in the graph.*\n`;
    } else {
      for (const [path] of orphans) {
        res += `- [[${path}]]\n`;
      }
      if (
        sortedNodes.filter((n) => n[1].total === 0).length > orphans.length
      ) {
        res += `  *(...and ${
          sortedNodes.filter((n) => n[1].total === 0).length - orphans.length
        } more)*\n`;
      }
    }

    if (topUnresolved.length > 0) {
      res += `\n#### ❓ Top Missing / Unresolved Link Targets:\n`;
      for (const [name, count] of topUnresolved) {
        res += `- \`[[${name}]]\` (linked ${count} time(s) but note not created yet)\n`;
      }
    }

    return res;
  }

  public async findGraphPath(fromName: string, toName: string): Promise<string> {
    const fromFile = this.resolveTFile(fromName);
    const toFile = this.resolveTFile(toName);

    if (!fromFile) return `Error: Note "${fromName}" was not found.`;
    if (!toFile) return `Error: Note "${toName}" was not found.`;
    if (fromFile.path === toFile.path)
      return `"${fromName}" and "${toName}" are the exact same note!`;

    const { outgoing } = await this.buildLiveLinkGraph();

    const adj: Record<string, Set<string>> = {};
    const addEdge = (u: string, v: string) => {
      if (!adj[u]) adj[u] = new Set();
      if (!adj[v]) adj[v] = new Set();
      adj[u].add(v);
      adj[v].add(u);
    };

    for (const [source, targets] of outgoing.entries()) {
      for (const target of targets) {
        addEdge(source, target);
      }
    }

    const start = fromFile.path;
    const goal = toFile.path;

    const queue: string[] = [start];
    const visited = new Set<string>([start]);
    const parent: Record<string, string> = {};

    let found = false;
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr === goal) {
        found = true;
        break;
      }

      const neighbors = adj[curr] || new Set();
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          parent[n] = curr;
          queue.push(n);
        }
      }
    }

    if (!found) {
      return `No path found in the graph connecting [[${fromFile.basename}]] and [[${toFile.basename}]]. They exist in separate graph clusters.`;
    }

    const path: string[] = [];
    let step: string | undefined = goal;
    while (step) {
      path.unshift(step);
      step = parent[step];
    }

    let out = `### 🔗 Graph Path between [[${fromFile.basename}]] and [[${toFile.basename}]]:\n\n`;
    out += `**Degrees of separation:** ${path.length - 1} hop(s)\n\n`;
    out += path.map((p) => `**[[${p}]]**`).join(" ➡️ ");
    return out;
  }

  public async connectNotesInGraph(
    sourceName: string,
    targetName: string,
    contextSentence?: string
  ): Promise<string> {
    const sourceFile = this.resolveTFile(sourceName);
    if (!sourceFile) {
      return `Error: Source note "${sourceName}" not found.`;
    }

    const cleanTarget = targetName
      .trim()
      .replace(/^\[\[/, "")
      .replace(/\]\]$/, "")
      .replace(/\.md$/, "");
    const linkText = `[[${cleanTarget}]]`;

    await this.flushOpenViewForFile(sourceFile.path);
    const existingContent = await this.app.vault.read(sourceFile);
    if (existingContent.includes(linkText)) {
      return `The link ${linkText} already exists in [[${sourceFile.path}]].`;
    }

    let appendText = "";
    if (contextSentence && contextSentence.trim()) {
      appendText = `\n\n${contextSentence.trim()}`;
      if (!appendText.includes(linkText)) {
        appendText += ` (${linkText})`;
      }
    } else {
      appendText = `\n\n- Related: ${linkText}`;
    }

    const updatedContent = existingContent + appendText;
    await this.app.vault.modify(sourceFile, updatedContent);
    this.syncOpenMarkdownViews(sourceFile.path, updatedContent);
    this.recordChange({
      itemKind: "note",
      path: sourceFile.path,
      type: "modified",
      previousContent: existingContent,
      newContent: updatedContent,
    });
    return `Successfully connected [[${sourceFile.basename}]] to [[${cleanTarget}]] in the graph view!`;
  }
}

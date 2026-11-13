# Obsidian AI Sidepanel Plugin

An intelligent, full-featured AI Assistant sidebar plugin for [Obsidian](https://obsidian.md). It connects to **any AI provider** using **any API key** (or local offline models) and **directly interacts with all your Obsidian vault notes** through autonomous agent tools.

---

## ✨ Key Features

- **🌐 Universal Provider Support ("Any AI Tool, Any API Key")**:
  - **OpenAI**: GPT-4o, GPT-4o-mini, o1, etc.
  - **Anthropic**: Claude 3.5 Sonnet, Claude 3 Opus, Claude 3.5 Haiku.
  - **Google Gemini**: Gemini 2.5 Flash, Gemini 1.5 Pro, Gemini 1.5 Flash.
  - **OpenRouter**: Access to over 100+ open and proprietary models with a single API key.
  - **Groq**: Ultra-fast low-latency inference (Llama 3.3 70B, Mixtral).
  - **DeepSeek**: DeepSeek-V3 and DeepSeek-R1 reasoning models.
  - **Local Offline Models**: Ollama (`http://localhost:11434`), LM Studio, LocalAI, vLLM.
  - **Custom Endpoints**: Any OpenAI-compatible reverse proxy or private enterprise endpoint.

- **🧠 Direct Obsidian Vault Interaction (Autonomous Tools)**:
  - `search_vault(query)`: Searches across all notes in your vault for titles, tags, and content keywords.
  - `read_note(path)`: Reads the full markdown content of any note in the vault.
  - `create_note(path, content)`: Creates new notes and automatically creates missing subfolders.
  - `append_to_note(path, content)`: Appends text, action items, or summaries to existing notes.
  - `replace_note_content(path, content)`: Rewrites or updates notes directly.
  - `list_notes(folder)`: Explores folder structures and catalogs notes.
  - `get_active_note()`: Fetches the open note's title and text for contextual reasoning.

- **⚡ Native Obsidian Integration**:
  - **Live Context Ribbon**: Displays the active note with an instant "Attached / Detached" toggle badge.
  - **Markdown & Math Rendering**: Full support for Obsidian links (`[[Note Name]]`), LaTeX math, formatted tables, and syntax-highlighted code blocks.
  - **Quick Editor Actions**:
    - 📋 **Copy to Clipboard**
    - 📝 **Insert at Cursor**: Direct insertion into the open document.
    - 📄 **Create New Note**: Instantly save any AI response as a standalone note.
  - **Command Palette & Ribbon Shortcuts**:
    - Ribbon sparkle icon to toggle sidepanel.
    - `Send selected text to AI Sidepanel`.
    - `Summarize active note in AI Sidepanel`.

---

## 🚀 Quick Installation

### Option 1: Development Build (Local Vault)
1. Navigate to the plugin directory:
   ```bash
   cd C:\Users\dchok\.gemini\antigravity\scratch\obsidian-ai-sidepanel
   npm install
   npm run build
   ```
2. Copy the resulting build files (`manifest.json`, `main.js`, `styles.css`) into your Obsidian vault's plugin directory:
   ```
   <YourVault>/.obsidian/plugins/obsidian-ai-sidepanel/
   ├── manifest.json
   ├── main.js
   └── styles.css
   ```
3. In Obsidian, go to **Settings** → **Community Plugins** → **Installed Plugins**, click the refresh icon, and toggle on **AI Vault Sidepanel**.

---

## ⚙️ Configuration

Open **Settings** → **AI Sidepanel**:

1. **Provider Preset**: Choose your provider (OpenRouter, OpenAI, Anthropic, Gemini, Groq, DeepSeek, Ollama, or Custom).
2. **API Key**: Enter your key (e.g. `sk-...`). Note: Ollama does not require an API key.
3. **Model Name**: Defaults to popular models (e.g., `google/gemini-2.5-flash`, `gpt-4o`, `claude-3-5-sonnet-20241022`). You can type any valid model string.
4. **Vault Interaction**: Enable/disable autonomous agent tools and set max tool iteration depth.
5. **System Prompt**: Customize personality and instructions to match your personal PKM workflow.

---

## 💡 Example Prompts

- *"Search my vault for all notes mentioning 'Q4 OKRs' and summarize our status."*
- *"Read [[Project Alpha]] and [[Meeting 2026-11-10]] and draft an executive briefing note in 'Briefings/Alpha-Summary.md'."*
- *"What are the recurring themes across my daily notes this week?"*
- *"Based on my active note, generate 5 challenging review questions and append them to the end of the note."*

# 🚀 LM-Studio-Context-Architect

[![Status: WIP](https://img.shields.io/badge/status-work--in--progress-orange.svg)]()
[![Platform: LM Studio](https://img.shields.io/badge/platform-LM%20Studio-blue.svg)]()
[![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)]()

**Stop copy-pasting files. Let your LLM explore your codebase.**

`LM-Studio-Context-Architect` is a smart prompt preprocessor plugin for LM Studio. It transforms local directories into a semantic, searchable knowledge base, allowing you to chat with entire codebases without hitting context window limits or losing architectural context.

## 🧠 The Problem: The "Context Wall"
When working with large codebases, you face two choices:
1. **The Manual Way:** Copy-pasting files one by one (slow, loses context).
2. **The Standard RAG Way:** Using chunk-based retrieval (fast, but often loses the "big picture" because it only sees tiny snippets of code).

## ✨ The Solution: Hierarchical RAG
This plugin implements a **Hierarchical Retrieval-Augmented Generation (RAG)** strategy. Instead of just searching for keywords in code chunks, it performs a two-tier analysis:

1.  **Semantic Summarization:** The plugin scans your local directory, strips out comments to save tokens, and uses an LLM to generate a high-level "architectural summary" of every file.
2.  **Summary-Based Retrieval:** When you ask a question, the plugin compares your query against the **summaries** (not the raw code). This allows it to identify the *correct files* based on their purpose.
3.  **Full-Context Injection:** Once the relevant files are identified, the plugin injects the **entire content** of those files into the prompt. This gives the LLM the full implementation details needed to provide accurate, working code.

## 🛠 Key Features

*   **📂 Automatic Directory Scanning:** Use the `@dir:/path/to/folder` trigger in chat to instantly bring a whole project into context.
*   **🧹 Intelligent Token Optimization:** Automatically strips comments (e.g., in `.cs` files) to maximize the amount of actual logic you can fit into the context window.
*   **🧠 Hierarchical Search:** Uses LLM-generated summaries to perform semantic searches, ensuring the LLM understands *what* a file does before it reads *how* it does it.
*   **⚖️ Hybrid Decision Engine:** Automatically decides whether to inject the full content (if the project is small) or switch to RAG (if the project is large) based on your specific `injectionThreshold`.
*   **🎯 Configurable:** Fine-tune your `retrievalLimit`, `targetExtensions`, and `injectionThreshold` via the LM Studio plugin settings.

## 🚀 Usage

1.  **Install** the plugin in LM Studio.
2.  **Configure** your target extensions (e.g., `.cs, .ts, .py`) in the settings.
3.  **Chat** with your code:

> **User:** `@dir:/Users/dev/MyProject Explain how the authentication flow works in this app.`

**The Plugin will:**
1. Scan `MyProject`.
2. Summarize the files.
3. Realize `AuthService.cs` and `LoginController.cs` are the most relevant.
4. Inject the full content of those files into the prompt.
5. Answer your question with full awareness of your code.

## 🚧 Roadmap (WIP)

This project is currently under active development. My current focus is:
- [ ] **Incremental Summarization (Current Focus):** Implementing a caching layer so that only modified files are re-summarized, making the `@dir:` command nearly instantaneous.
- [ ] **Graph-Based Relationships:** Moving from simple summaries to a true GraphRAG that maps function calls and class inheritance.
- [ ] **Multi-Language Support:** Expanding the comment-stripping logic to support Python, JavaScript, and C++.

## 🛠 Tech Stack
- **Runtime:** Node.js / TypeScript
- **SDK:** [@lmstudio/sdk](https://github.com/lmstudio-ai/lmstudio-sdk)
- **Embeddings:** Nomic Embed Text (via LM Studio)

## 📄 License
This project is licensed under the MIT License.

---
*Built with ❤️ for developers who want to talk to their code.*
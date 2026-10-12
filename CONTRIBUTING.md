# Contributing to Speckit Studio

Thanks for your interest! Speckit Studio is a personal project that I share as open source, and I'm happy about everyone who wants to help – whether it's a bug report, an idea, a fix or a whole feature. You don't need to be an expert in Spec Kit to contribute.

---

## 🏛 Principles

A few rules the code follows:

1. **Files are the source of truth** – specs, tasks, wiki and constitution are Markdown files in the user's repository; the app derives everything from them and never keeps a second copy.
2. **Local-only, zero cloud** – the app itself sends nothing anywhere: no accounts, no telemetry.
3. **Agent-agnostic via ACP** – agents are connected through the [Agent Client Protocol](https://agentclientprotocol.com); sign-in happens in the agent, the app stores no credentials.
4. **Respect the user's repository** – the app only writes where the user explicitly asks it to.
5. **Simplicity** – the simplest solution that works; no new dependencies without a good reason.
6. **Tested core logic** – parsers, state derivation and run handling have tests with Node's built-in test runner (`node:test`).

---

## 🛠 Setup

You need **Node.js** >= 22, **npm** >= 10 and **git** >= 2.30. [Claude Code](https://github.com/anthropics/claude-code) or Google Antigravity (`agy`) are optional – you only need them to try real agent runs.

```bash
git clone https://github.com/<your-username>/speckit-studio.git
cd speckit-studio
npm install
npm run dev
```

In development mode the app registers a deterministic **`Fake agent (dev)`**. With it you can click through complete agent runs, permission prompts and replies without any agent installed and without spending tokens.

Useful commands:

```bash
npm run dev        # the app with hot reload
npm test           # tests (node:test)
npm run typecheck  # TypeScript, main and renderer
npm run build      # production bundles
npm run pack       # unpacked app in dist/ to try the packaged build
```

Before you open a pull request, please run `npm run typecheck`, `npm test` and `npm run build`.

You don't need to release anything yourself: every push to `main` that passes CI is built for macOS, Windows and Linux and published as a GitHub release (`.github/workflows/release.yml`, details in [docs/RELEASE.md](docs/RELEASE.md)).

---

## 🔄 How changes are made

**Small things** (bug fixes, typos, docs): create a branch such as `fix/short-description`, make your change, check that tests and typecheck pass, and open a pull request.

**Larger features**: please open an issue first and describe what you have in mind – I'm happy to talk it through before you put work into it. How you work on it afterwards is up to you; you don't need Spec Kit for that.

---

## 📦 Pull requests

- Base your branch on the latest `main`.
- Fill in the pull request template.
- I review pull requests as soon as I can. Since this is a spare-time project, it may take a few days – please don't hesitate to ping me if it's been quiet for a while.

---

## 📜 Code of Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).

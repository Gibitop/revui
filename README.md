# RevUI

A local code-review workspace for macOS and Windows. See [plan.md](plan.md) for the roadmap and implementation status.

Local review is implemented: open repositories, compare commits or local changes, browse diffs and full files, and save local threads and reviewed markers. It works offline with the installed Git CLI. Workspace preparation and IDE launching are available. GitLab collaboration and AI review through Codex or OpenCode are also available.

The shell has one toolbar and a monochrome palette. Color is reserved for semantic information such as added/deleted lines. Typography is limited to three styles: UI text (Geist, 400), labels (Geist, 600), and paths/code (Geist Mono, 400), all at 13px/20px with normal letter spacing and no text transforms.

## Run locally

Install Node.js 24 LTS, pnpm 11.25.0, and Git. On Windows, install Git for Windows and make Git available on `PATH`. Use native PowerShell or Command Prompt; WSL is not the desktop runtime.

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm run dev
```

`setup` ensures Electron is downloaded.

To run a production build:

```sh
pnpm run build
pnpm run start
```

Open a repository with the folder picker or **Cmd/Ctrl+O**. Open preferences with **Cmd/Ctrl+,**. Selecting a nested folder opens its Git working-tree root. Opening a repository does not check out, stage, or modify files.

## Local review

Click the project name (or **Cmd/Ctrl+O**) to open a repository dialog. Choose a recent project, or **Add repository** to open the system folder picker. The top toolbar leaves a dedicated empty area for dragging the window.

The repository opens its last comparison. **Old** is the baseline; **New** is the revision being reviewed. Both fields suggest local branches, remote-tracking branches, tags, and recent commits, and accept typed refs or hashes. Use Old `HEAD` / New `Uncommitted` for all local changes, Old `HEAD` / New `Index` for staged changes, or Old `Index` / New `Uncommitted` for unstaged changes. Changing either field reloads the comparison; the refresh icon fetches and refreshes. **Merge-base** is available when both revisions are commits. Commits and index blobs remain pinned within a loaded comparison.

The sidebar's icon tabs select **Changed files**, **All files**, or **Unresolved threads**. All files shows the reviewed revision plus paths deleted in the active diff. Select an unchanged file to read its full content. Search paths with **Cmd/Ctrl+P**. Drag the divider between the sidebar and code; it also supports left/right arrows when focused. Its width persists. Toggle the sidebar with **Shift+F**, use the panel button, or drag its divider to the left edge; the Show file sidebar button restores it at its previous width. The collapsed state also persists. Use **Alt+Up/Down** for previous/next changed file and **Alt+Shift+Up/Down** for previous/next unresolved thread. The tree supports arrow-key navigation. Settings has an Appearance/Workspace/Worktrees sidebar. Appearance contains theme and layout controls for split/unified diffs and continuous/focused review; these choices apply across repositories and persist. Enable the **Wrap long lines** switch in Settings → Appearance to wrap code in both diffs and full-file views.

**Search file contents** (**Cmd/Ctrl+F**) searches text in the reviewed revision, including unchanged files and non-ignored untracked files for Uncommitted. Matching is literal and case-insensitive. Select a result to open and highlight its line, including lines outside the initial viewport. Results show up to 500 matches; `500+` means the search should be narrowed. Binary files and submodule contents are excluded. Changed local content asks you to compare again.

Click or drag line numbers to select a comment range. A compact composer opens directly below that range; in split mode it stays on the selected side. The range and side come from the selection. Threads, replies, resolution state, and reviewed markers are local to the comparison. Unresolved notes remain accessible through the Unresolved threads tab, including files absent from the comparison. When content changes, earlier threads become outdated and reviewed markers no longer count as current. Reopening the same comparison restores unchanged notes and progress. Local comments render Markdown, show per-comment relative update times with full dates on hover, and can be deleted individually. Deleting the last comment removes its thread. File headers include a copy button for the repository-relative path and collapse or expand the diff; marking a file Reviewed collapses it. The tree and headers display color-coded Git status, and the sidebar includes added/deleted text-line totals.

Metadata loads before file content. Diff parsing, tree preparation, and highlighting run in workers; the diff and tree components virtualize their rendered rows. Files over 1 MiB or 20,000 lines require **Load complete file**. Binary/non-UTF-8 files receive a summary, symlinks show their target without following it, submodules show their reference/working-tree status, conflicts are labeled explicitly, and executable-mode changes remain visible. Errors do not silently truncate or discard files. Index snapshots remain pinned if Git staging changes; working-tree reads detect changes and ask for a refresh.

Review records live in versioned JSON under `userData/reviews/<repository hash>/<comparison hash>.json`; the last comparison is stored alongside them. Writes are serialized and atomic. Unreadable or unsupported records are left untouched and editing them is blocked with an error. This application never checks out or edits repository source while browsing.

## Workspace tools

Use the lightning bolt in the top bar to initialize a workspace. RevUI compares resolved commit IDs, so a tag or branch at the checked-out commit runs setup directly. Local changes also use the existing checkout; a staged snapshot can use it when the tracked files match the pinned index. Otherwise, choose **New worktree** or **Current checkout** and select **Prepare workspace**. Differing staged snapshots require a worktree. Reopening a diff automatically selects an existing managed worktree at the same target revision and restores its successfully initialized state. Setup failures can retry in that worktree without creating another. The bolt spins during initialization and turns yellow only after setup succeeds. The adjacent IDE split button opens the whole project and stays disabled until initialization succeeds. Historical browsing itself never changes your checkout.

In-place preparation proceeds directly for a clean checkout. It asks for confirmation only when local changes need stashing. RevUI records the original branch/commit and the exact stash object in `userData/workspaces.json` before proceeding. Switching comparisons, switching repositories, or closing the app offers **Restore**, **Leave as-is**, or **Cancel**. Restoration refuses new workspace changes or a moved original branch. It applies only the recorded stash with its staged state, and retains that stash as a recovery copy even after success.

If restoration conflicts or is interrupted, Settings → Worktrees shows the recovery stash and error. Resolve conflicts and recover the original checkout manually, then use **I restored manually…**. The app verifies the original checkout and absence of unresolved index conflicts before clearing the pending restoration. Do not apply a stash twice; inspect the workspace first. Recovery records survive restart. Managed worktrees remain under `userData/worktrees`; manage them across all repositories in Settings → Worktrees, even with no repository open. Cards are grouped by repository and show each revision with its current branch and tag names. Icon buttons copy the full revision or worktree path, and open the directory in Finder or Explorer; matching worktrees are reused automatically. Manually deleted worktree directories are removed from the saved list when it refreshes, including on return to the app; in-place recovery records are retained. The trash icon removes a worktree and refuses changed HEADs, tracked changes, and non-ignored untracked files. Ignored files such as installed dependencies or build output require explicit confirmation before removal.

Configure a single post-checkout script for the current machine in Settings → Workspace. Commands can apply globally or override one repository. Choose All repositories for defaults or This repository and enable Repository-specific commands for an override. Save them before preparation; they run in the prepared directory and stream output into the dialog. Failures leave the workspace available for inspection and retry. Click the spinning workspace button to cancel setup and stop its process tree. Initialization runs without a progress or success modal; failures open an error dialog with captured output and a retry action. Commands are never imported from repository files.

Each file header has an icon-only IDE split button beside Copy relative path. The dropdown opens that file in Cursor, VS Code, IntelliJ IDEA, or WebStorm, and remembers the chosen IDE. The main icon repeats that choice. It opens the actual file on disk in the active workspace (or the repository checkout), even during historical/index comparisons; no preparation is required. Selected target lines and search results supply the line number. Paths resolving outside that workspace are rejected.

## Checks

```sh
pnpm run check          # TypeScript + Hooks lint + formatting + Vitest
pnpm run test:e2e       # Build + Playwright desktop review tests
pnpm run test:benchmark # Opt-in 100,000-file / 1,000-change desktop measurement
```

Desktop tests require a graphical desktop session. They use temporary repositories and isolated settings directories, not your normal app preferences. Playwright uses the installed Electron binary; a separate browser download is not required.

The GitHub Actions workflow runs the same checks on macOS and Windows. Windows execution is pending the first CI run; local validation was performed on macOS arm64.

## GitLab review

Connect under **Settings → GitLab** using your instance URL and a personal access token with `api` scope. Tokens are encrypted using the OS credential store and never returned to the renderer. TLS verification is enabled by default; TLS settings accept an additional PEM CA certificate or an explicit verification override for your instance.

Choose the MR target branch in **Old** and source branch in **New**. Local branches and `origin/...` refs are supported. The app discovers the nested project from `origin` and looks for open MRs matching both branches and the source project. Commit hashes, tags, Index, and Uncommitted comparisons do not infer an MR. SSH aliases and instance mismatches produce an error instead of guessing.

The MR button beside Search shows a spinner during lookup. A cached match opens a right-side overlay; a click after a miss retries lookup. A miss flashes red for one second. Multiple matching MRs are offered for selection. The overlay includes metadata, pipeline and approval status, description, all discussions (including outdated/unplaced ones). Available deployed review apps for the MR branch include View app and Copy app link actions; multiple environments are listed by name.

Use **Fetch and open MR revision** when the local comparison differs from the GitLab diff. Equivalent file changes remain reviewable even when commit SHAs differ. New inline threads default to GitLab when available; switch to Local in the shared composer if needed. Adjust **From line** and **to line** with the small minus/plus buttons. **Insert suggestion** above the input fills a replacement block with the selected code (GitLab suggestions use the new side). Below the input, choose **Post now** or **Cancel**. The general MR comment input only needs **Post now**. Local and GitLab threads share the same layout, icon actions, and expandable reply composer with immediate posting. Your GitLab comments can be edited or deleted, and resolvable discussions can be resolved or reopened. The Upload to GitLab action posts a local comment at its original range when it matches the MR, removing the local comment after GitLab confirms posting. Failed or uncertain uploads retain the local comment. Current inline GitLab discussions appear in the diff and unresolved-file navigation.

GitLab comments, replies, edits, deletions, resolution, and personal approval update immediately while requests run. Failed requests restore the previous state; successful requests reconcile with GitLab. Posting rechecks the MR revision and comment positions. Failed posts keep the text in the composer. An interrupted or uncertain creation is never automatically retried: refresh and inspect GitLab before trying again. Use local comments to keep review notes before uploading them to GitLab. MR details includes local threads with a Local tag, file location, and View in diff action. **Publish all local comments** uploads them in order, keeping replies in the same GitLab discussion and removing each local comment only after confirmed posting. Publishing stops at an outdated comment or a failed request; the remaining comments stay local.

The active MR refreshes every 60 seconds while the window is focused, on focus, and using **Refresh**. New revisions show a banner; loading them is explicit. Approval sends the reviewed head SHA. This milestone is tested against local API fixtures; verify workflows against your designated GitLab test project before relying on production writes.

## Code layout

- `src/main`: privileged desktop services, repository inspection, Git comparisons, local review persistence, settings, and IPC handlers.
- `src/preload`: the narrow bridge exposed as `window.desktop`.
- `src/shared`: IPC names and desktop types; no privileged code or runtime dependencies.
- `src/renderer/src`: React workspace, shadcn-style UI primitives, themes, Query caches, and local React UI state.
- `scripts`: desktop setup.
- `tests`: Electron end-to-end tests.

Electron owns the desktop runtime; development tools run with Node.js, and pnpm manages packages and scripts. Keep Vite on the major supported by Electron Vite (currently 7), with the matching React plugin (currently 5). `pnpm-lock.yaml` records the complete dependency graph. Dependency build scripts are explicitly allowed in `pnpm-workspace.yaml` for Electron and esbuild.

Preferences are stored in `settings.json` under Electron's `userData` directory. Writes are serialized and atomic; unreadable files are preserved with an `invalid` filename before defaults are loaded. A file from an unknown schema version is left untouched and startup stops with an explanation.

In development, `REVUI_USER_DATA` can point to an existing temporary directory to isolate app data. The renderer is sandboxed, cannot access Node directly, and only receives explicitly exposed IPC methods. Production builds use a restrictive Content Security Policy; development additionally permits Vite's refresh preamble and local HMR websocket.

Third-party licenses for installed packages are included under their respective `node_modules` directories. UI primitives follow shadcn/ui's Radix composition pattern and are owned by this application.

Electron E2E tests use hidden windows (`REVUI_TEST_HIDDEN=1`) with background throttling disabled. Electron still requires a graphical session; on Linux CI, run under Xvfb. The packaged app ignores this test flag.

Development watches main and preload modules as well as the renderer. Restart any existing dev process once after updating the dev command to pick up `--watch`.

## UI conventions

Use switches for boolean settings. Use Lucide for UI icons and SVGL for brand logos. Never hand-code icons or recreate brand marks. Vendored IDE logos and their source attribution live in `src/renderer/src/assets/ide`.

Use the local shadcn-style controls in `components/ui` and Tailwind utilities for application UI. Radix supplies dialogs, tooltips, and selection controls; the shadcn combobox uses Base UI to support editable Git refs. Keep CSS for tokens, base rules, Markdown, Electron drag regions, and Pierre shadow DOM integration. Keep the established Geist typography and compact monochrome layout.

Comparison opening is an explicit renderer operation. Its request ID owns cancellation through IPC; Query caches file content and review records only for the active snapshot. Components are grouped by responsibility, with related types and behavior colocated.

Run `pnpm run format` before committing. Hooks lint uses Babel's TypeScript parser because typescript-eslint does not support the repository's TypeScript 7 compiler.

## AI providers and review

Install the Codex CLI and sign in with `codex login`. RevUI reuses that installation and authentication through its [stdio app-server protocol](https://learn.chatgpt.com/docs/app-server). No API key or token is stored in renderer state. The adapter was checked against Codex 0.146.0. On Windows it supports a native `codex.exe` or the standard npm installation; macOS also checks common Homebrew and local binary directories.

In **Settings → AI Providers**, configure the Codex and OpenCode binary paths and check availability. Providers are checked automatically at startup and every five minutes, even while settings are closed. OpenCode v2 is required. RevUI uses the official [`@opencode/client`](https://github.com/anomalyco/opencode/tree/v2.0.18/packages/client) SDK to communicate with a local authenticated server and reuses your installed authentication (`opencode auth login`). Its review agent is added through an in-memory configuration overlay; your configuration and credentials are not copied or edited.

In **Settings → AI Scenarios**, choose a provider, model, and supported reasoning effort separately for Chat, Code review, and Review order. Set **Preferred response language** for chat, findings, and review-step explanations; leave it blank for automatic selection. Models and their reasoning effort choices preload for every provider at startup and refresh every five minutes. Scenario selectors share that data, so changing providers or models does not trigger another discovery request. OpenCode versions/models that do not advertise choices use their provider defaults. Defaults use the provider configuration. Provider changes apply on the next chat message, including in existing chats. Switching providers starts a new provider session with the earlier conversation as context. Model changes apply to the next run, and changing review-order settings invalidates its cache.

Open **AI review** beside the GitLab button. Chat is scoped to the pinned comparison. Available MR metadata, description, discussions, and approval context are included automatically in system instructions, without the diff. Use **Attach thread to AI** for local discussions. **Review changes**, beside the provider name in the panel header, runs a separate background review and automatically creates local comments authored by **AI**. Chat stays available for your questions, and neither its messages nor its draft are affected. Press Enter to send a message and Shift+Enter for a newline. Drag the left edge of the AI panel to resize it, or focus the divider and use the arrow keys; its width is saved.

The file sidebar has separate **File view** (Tree view / Flat list) and **File ordering** (Filesystem order / AI review order) controls. Reviews always open in Filesystem order and remember your last Tree/List layout. In AI ordering, Tree view gives each review section its own collapsible tree that grows with its contents. Section headings stay visible while scrolling. Choosing AI review order lazily starts a separate background request and displays the parsed review steps as sections of files, with rationale, file-type icons, Git statuses, and status colors. A loading indicator shows while the guide is prepared. The generation conversation never appears in chat and cannot open approval dialogs. Results are cached across closing/reopening the view and app restarts; changed comparison parameters or mutable Git content invalidate the cache. Clicking a path navigates to that file. Next/previous buttons, keyboard navigation, and continuous diffs follow section order while AI ordering is active, using filesystem order within each section in Tree view.

Read-only chat works without workspace initialization for historical, staged, and working-tree comparisons. It reads pinned commits and staged contents directly through Git and leaves the current checkout unchanged. Modes that allow edits still require a matching checkout; staged editing creates or reuses an isolated index worktree. Worktrees remain available for explicit cleanup in Settings. Configured setup scripts still run only through the lightning button.

For Codex, the permission selector below the chat composer is saved per chat. **Read only** is the default and denies edits and escalation without prompting. **Ask for approval** allows workspace edits and asks before sandbox escalation. **Approve for me** uses the same sandbox with Codex’s automatic approval reviewer. **Full access** removes the sandbox and approval prompts. Change modes between responses; pending approvals appear outside the transcript and belong to their chat. RevUI verifies the selected policy on new and resumed sessions and rejects unsupported CLI or organization policies without silently changing modes. Background review and review-order generation always remain read-only. Workspace and snapshot checks still invalidate results if the reviewed contents change.

AI comments use the normal local-thread controls for editing, replies, resolution, deletion, and explicit upload to GitLab. Repeated identical findings do not create duplicate comments. AI never publishes comments automatically.

Use **New chat** (+) to start a separate conversation and × on a tab to close it. Tabs and conversation history persist across restarts; drafts and attachments stay with their tab while the panel is open. Chats respond independently in the background. Switch tabs or create another chat while a response is running; each tab shows its own progress. Use the pencil on your latest message to edit and resend it; this replaces its reply while preserving earlier conversation and attachments. Cancel stops only that chat, and closing a running tab stops its response. Closing the last tab opens an empty chat. Tool activity stays hidden, and replies scroll into view unless you scroll up. File references in assistant replies open the file in the review, including inline code and Markdown links; line references jump to the indicated line. Only known repository files and unambiguous filenames become links.

OpenCode supports Read only, Ask for approval, and Full access; it does not provide Codex’s OS sandbox or automatic approval reviewer. Read only denies shell execution and editing tools. A local authenticated MCP tool gives the model constrained, shell-free Git reads for inspecting pinned commits and staged/working comparisons. Ask for approval prompts before side-effecting tools, and Full access allows them. Background review and review order always use Read only. RevUI requests JSON in the OpenCode prompt and validates it with the same snapshot/anchor checks as Codex. Unsupported permission modes fail before sending a prompt. RevUI waits for agent discovery and applies explicit session permissions before starting or resuming a review.

**Cancel** interrupts the turn; the next message resumes the saved provider session when supported. Transcript, findings, walkthrough state, and session IDs are written atomically under `userData/ai`. Refreshing a mutable comparison preserves its earlier results as outdated; starting a new chat turn starts a session for the new generation. Invalid background findings produce an error without adding chat messages or comments. **Cancel review** stops background review independently of chat.

Model requests contain only the diff parameters—working directory, pinned source and target endpoints, and merge-base mode—plus explicitly attached references and automatically supplied MR context. RevUI never embeds the diff or file contents in a prompt; the model reads Git itself. File and selected-line attachments carry paths and ranges. Explicit discussion attachments remain subject to the 3 MiB request limit. Finding anchors are checked against file contents locally after the response. Broader live-model scenarios and Windows desktop behavior still require manual validation; deterministic protocol and Electron fixtures cover the review flow without contacting a model.

AI code review includes existing GitLab discussions and local threads (including resolved threads) to avoid repeating issues. It may return no findings. Comments support Markdown and GitLab suggestion fences, with leading priorities rendered as colored tags: P0 critical, P1 high, P2 normal, and P3 low. Priority prefixes and suggestion syntax remain intact when editing or publishing comments.

OpenCode validation: `REVUI_LIVE_OPENCODE=1 node node_modules/vitest/vitest.mjs run src/main/opencode.test.ts` checks the installed CLI without model turns. Add `REVUI_LIVE_OPENCODE_TURN=1` to exercise one authenticated model turn against a temporary test repository. Add `REVUI_LIVE_OPENROUTER=1` to check the four reported OpenRouter model selections and use DeepSeek V4 Flash for the model turn. Normal tests use deterministic subprocess fixtures. OpenCode 2.0.18 was checked locally on macOS; Windows native executable validation remains pending.

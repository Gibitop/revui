# RevUI implementation plan

## 1. Product and scope

Build a local code-review application for developers on macOS and Windows. Start with a useful local diff viewer, then add GitLab collaboration, AI review, and TypeScript tooling.

Use Electron, React, TypeScript, shadcn/ui, Tailwind, `@pierre/diffs`, `@pierre/trees`, and pnpm. Initially, developers clone the repository and run setup commands; signed installers and automatic updates are deferred.

The app supports reading code, writing review comments, and composing suggestions. Direct source editing, staging, committing, pushing, and merging MRs are outside this plan.

**Plan artifact:** This file is the implementation reference. Maintain the milestone checklist below as work progresses.

## 2. Architecture and UI

### Application structure

- Use one application package with Electron main/preload code and React renderer code, built with Electron Vite.
- Use pnpm for dependency installation and development scripts. Desktop services run under Electron’s Node runtime.
- Keep Git, GitLab, workspace management, harness integration, persistence, and language tooling in cohesive feature modules. Keep single-use types and logic beside their consumers.
- Expose narrow, typed IPC methods and event subscriptions through preload. Validate requests at the main-process boundary.
- Keep credentials, filesystem access, subprocesses, and network requests outside the renderer. Enable renderer sandboxing and context isolation; sanitize rendered Markdown. Follow [Electron’s security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
- Use asynchronous Git subprocesses and workers for expensive parsing. Support cancellation and ignore stale responses after switching comparisons.

### Rendering and state

- Use Pierre components for diffs, read-only files, and the file tree. Use their virtualization and highlighting workers; prepare large tree inputs outside React. [Diffs documentation](https://diffs.com/llms-full.txt), [Trees documentation](https://trees.software/docs)
- Use TanStack Query for asynchronous desktop data and a small Zustand store for shared UI state.
- Store settings and review records as versioned JSON under Electron’s application-data directory, using atomic writes. Separate records by repository and review; do not persist large repository trees in review records.
- Encrypt GitLab tokens through Electron `safeStorage`; keep plaintext tokens out of renderer state and logs. [safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage)
- Persist local threads, reviewed-file progress, AI findings, walkthroughs, panel preferences, and harness session identifiers.

### Review interface

- A single top toolbar: repository selector, comparison controls, search and adjacent MR buttons, and settings. Integrate native window controls into this row.
- Left: searchable file tree.
- Center: continuous multi-file diff by default, with a focused single-file mode.
- MR metadata opens in a right-side overlay like search, triggered by the button beside Search. Include title, metadata, discussions and approval actions.
- Right: collapsible, resizable AI chat. Grouped review walkthroughs appear under AI review order, independently of the remembered Tree/List layout.
- Provide unified/split diffs, light/dark/system themes, resizable panels, keyboard navigation, file search, next/previous change, and next/previous unresolved thread.
- Use a monochrome palette. Reserve color for semantic UI such as added/deleted lines and diagnostic status.
- Use at most three text styles: regular UI text (Geist 400), emphasized labels (Geist 600), and code/paths (Geist Mono 400). All use 13px font size, 20px line height, normal letter spacing, and no text transforms.
- Only show elements that currently serve a purpose. Add tabs, file navigation, panels, and controls when their features exist; omit decorative copy, duplicate actions, empty status bars, and placeholder panels.
- Keep spacing compact and animation minimal.

Tree filters are **All files**, **Changed files**, and **Unresolved threads**. All-files mode represents the target revision, retaining deleted paths needed for the active diff. Unresolved threads include local and GitLab discussions and AI findings.

## 3. Core behavior and interfaces

### Git comparisons and review identity

Use the installed Git CLI, invoked with argument arrays rather than interpolated shell commands.

Represent comparison endpoints explicitly as a commit, index, or working tree. Resolve branches, tags, and abbreviated hashes to immutable commit IDs when opening a comparison.

Support:

- Any two commits or refs, including remote-tracking branches.
- Direct comparison by default, with a clearly labeled merge-base comparison option.
- Staged changes: `HEAD` → index.
- Unstaged changes: index → working tree.
- All uncommitted changes: `HEAD` → working tree.
- A selected commit → index or working tree.
- Non-ignored untracked files in working-tree views.

Treat a review snapshot as the repository, resolved endpoints, comparison mode, and a content generation for mutable local state. Refreshing local changes creates a new generation; AI results and progress must not silently attach to changed content.

Load file metadata first and patches/content on demand. Handle renames, deletions, executable-bit changes, binary files, symlinks, submodules, and conflicted files explicitly. Never silently omit files or truncate a diff.

### Workspaces and local tools

Basic diff browsing reads Git objects without checking anything out.

When AI or TypeScript tooling needs a different revision:

- Initialize using an icon-only lightning bolt in the top bar. Resolve commit identities first; when the target matches the checkout, run setup directly. Otherwise ask whether to create an app-managed worktree or check out in place, with one primary action. Show a spinner during initialization and yellow after successful setup.
- For dirty in-place checkout, show an explicit stashing warning. Stash tracked and untracked changes, preserving the original checkout and exact stash identity.
- Block the operation if stashing or checkout fails; do not discard changes.
- Allow a user-configured post-checkout script, with repository overrides, running on the current machine. Show execution output and failures.
- When leaving an in-place review, prompt to restore the original workspace or leave it as-is.
- Restore only the app’s recorded stash. Preserve it on conflicts and show recovery instructions; never force restoration over new changes.
- Reuse matching managed worktrees when reopening a diff, comparing commit IDs or immutable index trees and restoring persisted initialization state. Persistently remove missing worktree entries when refreshing the list; retain in-place recovery records and skip changed checkouts when reusing worktrees.
- Manage worktrees across all repositories in Settings → Worktrees, including when no repository is open. Provide copy buttons for the full revision and path, plus an icon to open the directory in Finder/Explorer. Cards show the revision with associated branches and tags, and a trash icon for removal; matching worktrees are selected automatically. Retain them until explicit cleanup and check for user changes before removal.

Reviewing current local changes uses the existing workspace. Read-only AI chat and reviews inspect staged contents directly through Git without preparing a workspace. Modes that allow edits prepare an isolated snapshot matching the index so unstaged changes do not enter the editable workspace.

Provide built-in IDE launchers with file/line arguments. A project IDE split button beside the lightning bolt opens the initialized workspace root; disable it before setup succeeds and explain why in a tooltip. Each file header provides an icon-only IDE split button beside Copy relative path, with Cursor, VS Code, IntelliJ IDEA, and WebStorm. Remember the selected IDE. Open the actual file on disk in the active workspace or current checkout, including during historical/index comparisons, without requiring workspace preparation.

### GitLab integration

Configure a self-hosted instance URL and personal access token. Infer project identity from `origin`, supporting HTTP, HTTPS, SSH URLs, nested groups, and `.git` suffixes. Surface ambiguous SSH aliases or instance mismatches rather than guessing.

List the inferred project’s open MRs, prioritizing the checked-out source branch. Resolve MR identity and canonical URL through GitLab; do not assume a branch identifies exactly one MR.

On opening a diff, look up open MRs using **New as source branch** and **Old as target branch**, preserving branch names separately from resolved commit IDs. Accept local branches and `origin` remote-tracking branches; commit/tag and mutable comparisons have no inferred MR. Match the inferred source project as well as both branch names. If multiple MRs match, let the user select one.

The adjacent MR button opens the side overlay when a match is cached. Otherwise clicking retries lookup. Show a spinner for the entire lookup; when no MR is found, turn the button red for one second and then restore its normal appearance. Network/authentication errors remain distinguishable from an empty result. Reset lookup state on comparison changes and ignore stale responses.

Implement:

- MR title, description, tags, author, reviewers, source/target branches, status, pipeline summary, and approval state.
- General comments, inline discussions, replies, resolved discussions, and outdated discussions.
- Create comments and suggestions, edit permitted comments, resolve/reopen threads, approve/unapprove.
- Per-comment **Post now**, with local comments that can later be uploaded to GitLab.
- Local-only AI findings until the user explicitly publishes them.

Use GitLab’s diff-version references and old/new paths and line positions for inline comments. Keep GitLab anchors distinct from local comparison anchors. Comments that cannot be placed accurately remain accessible in an outdated/unplaced discussion view. [Discussions API](https://docs.gitlab.com/api/discussions/)

Pin each MR review to its loaded revision. Poll the active MR every 60 seconds while focused, refresh on window focus, and provide manual refresh. New commits show an update banner; switching revisions is explicit.

Before posting comments, validate the current MR revision and comment anchors. Approval includes the reviewed head SHA so GitLab rejects stale approval. [Approval API](https://docs.gitlab.com/api/merge_request_approvals/)

Keep composer text on posting failures. Do not automatically retry an uncertain comment creation, which could duplicate a successful post. Local comments remain available until an upload is confirmed.

### Local review records

Support persistent local inline threads, replies, resolution state, and reviewed-file markers without GitLab.

Anchor records to a review snapshot, file path, diff side, and line range. Invalidate reviewed markers when the relevant content changes. Preserve outdated notes rather than moving them to an uncertain location.

### AI integration

Implement a small internal harness interface for:

- Availability and version checks.
- Session start/resume.
- Sending context and prompts.
- Streaming messages and tool activity.
- Command approval requests.
- Cancellation and session failure.
- Capability reporting.

Build Codex first using its stdio app-server interface, which supports embedded conversations, streaming events, and approvals. Add OpenCode v2 through its official TypeScript client SDK afterward. Keep provider-specific behavior inside adapters rather than building a general plugin framework. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [OpenCode client SDK](https://github.com/anomalyco/opencode/tree/v2.0.18/packages/client)

Reuse installed harnesses and their existing authentication. Show actionable setup errors when a harness is missing or incompatible.

AI features:

- Chat scoped to the repository and active review, with optional local-thread attachments and automatic MR context in system instructions. Send only comparison parameters (working directory, source, target, merge-base mode), never diff/file contents; the model inspects Git itself. Enter sends; Shift+Enter inserts a newline.
- **Review changes** beside the Codex panel title runs in a separate background session and creates local comments authored by AI without affecting chat. Selecting **AI review order** in the ordering menu lazily generates and caches structured review steps in a separate, hidden model conversation.
- Findings containing severity, explanation, path, side, line range, and optional replacement code.
- A grouped walkthrough of related files/hunks with rationale, file icons, Git status colors, and navigation in section order.
- Valid findings automatically become local AI comments, with standard editing, resolution, deletion, and explicit GitLab upload.

Request structured review results and validate them against the snapshot before displaying actionable annotations. Invalid or unanchored output produces a background error without adding chat messages or comments. Do not change the user’s review order automatically.

Configure review sessions to read source and request approval for commands. Disable source-editing tools where supported. An approved command can still create artifacts or modify files; detect resulting changes and mark affected review results stale. If a harness cannot enforce the required permission behavior, disable command execution for that adapter.

### TypeScript tooling and suggestions

Use `typescript-language-server` with the reviewed project’s TypeScript version when available and a bundled fallback. Support TS, TSX, JS, and JSX according to project configuration. [Language-server documentation](https://github.com/typescript-language-server/typescript-language-server)

Initially provide semantic features on the reviewed/target side:

- Hover information and go to definition in diffs and full-file views.
- Navigation into unchanged files in the same review workspace.
- Completion and diagnostics in GitLab suggestions and editable AI code proposals.

Use Monaco for editable suggestion blocks. Bind a suggestion to a file and replacement range, then apply it to an in-memory full-file document. Map completion edits and diagnostics back into the visible block without writing source files.

Maintain a separate, lazily started suggestion language-server session so speculative edits do not change normal review hovers. Analyze one active suggestion overlay at a time. Changes outside the selected replacement range require an explicit expanded suggestion.

AI snippets without a file/range binding receive syntax highlighting until attached to project context. Missing dependencies or generated files show a setup status rather than misleading diagnostic certainty.

Base-side semantic navigation and other language servers are deferred.

## 4. Implementation milestones

| Milestone                      | Deliverable and completion criteria                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Foundation**              | Save `plan.md`; scaffold Electron/React/pnpm; establish IPC, settings, themes, and test tooling. Confirm startup on macOS and Windows.                                                               |
| **1. Local review**            | Open/reopen repositories; implement all comparison modes, both layouts, tree filters, local threads, reviewed markers, and lazy diff loading. Usable offline without GitLab or AI installed.         |
| **2. Workspace tools**         | Add worktree/in-place preparation, safe stash restoration, post-checkout scripts and IDE opening. Verify failure recovery before enabling GitLab-driven workspace preparation.                       |
| **3. GitLab review**           | Add token setup, `origin` discovery, MR selection/metadata, all discussion workflows, suggestions, direct posting, refresh handling, and approval. A complete human MR review can happen in the app. |
| **4. Codex review**            | Add chat, approvals, cancellation/resume, structured findings, publishing selected findings, and grouped walkthroughs. Results remain tied to the reviewed snapshot.                                 |
| **5. OpenCode**                | Add the OpenCode v2 SDK adapter and run the same chat/review acceptance scenarios. Surface capability differences explicitly.                                                                        |
| **6. TypeScript intelligence** | Add target-side hovers/definitions and contextual suggestion completion/diagnostics without source writes.                                                                                           |
| **7. Team readiness**          | Complete monorepo benchmarks, accessibility and keyboard checks, recovery testing, onboarding documentation, and macOS/Windows setup verification.                                                   |

Each milestone ends with a usable application, relevant automated checks, and an updated `plan.md`. Performance work happens throughout rather than being postponed to milestone 7.

### Implementation status — September 24, 2026

**Milestone 0: implemented and verified on macOS arm64; Windows verification pending CI.**

- [x] Electron Vite, React, TypeScript, pnpm, Tailwind, and shadcn-style UI primitives scaffolded.
- [x] Typed preload API, main-process request validation, sandboxed renderer, navigation restrictions, and production CSP.
- [x] Versioned settings with serialized atomic writes, corrupt-file backup, and unknown-version protection.
- [x] Monochrome light/dark/system themes, three text styles, and a single toolbar. Only functional controls are exposed; stored layout preferences remain compatible for later milestones.
- [x] TanStack Query for desktop data and Zustand for workspace UI state.
- [x] Repository picker and recent-repository reopening implemented ahead of milestone 1; these inspect Git metadata only.
- [x] Eight Vitest settings/Git tests, TypeScript checks, and production build pass locally.
- [x] Playwright verifies Electron startup, theme changes, IPC restrictions, repository selection, and preferences/recent repositories across restart.
- [x] Development startup (`pnpm run dev`) verified in the native macOS window, including the renderer/preload connection.
- [x] Setup documentation and a macOS/Windows CI matrix added.
- [x] Clean pnpm frozen-lockfile installation verified; package scripts, CI, setup instructions, and the lockfile all use pnpm. Existing preference files remain readable after the UI simplification.

**Milestone 1: implemented and verified on macOS arm64; Windows verification pending CI.**

- [x] Repository picker/reopening and persisted last comparison per repository.
- [x] Direct and merge-base ref comparisons, staged, unstaged, all uncommitted, and selected commit → index/working tree. Refs resolve to immutable commits; index content is pinned by blob IDs.
- [x] Non-ignored untracked files, renames, deletions, executable modes, binary/non-UTF-8 files, symlinks, submodules, conflicts, and unborn branches handled explicitly.
- [x] Metadata-first loading with per-file lazy content, cancellation on comparison changes, generation IDs, stale-response rejection, and working-tree change detection. Large files require an explicit complete-load action.
- [x] Pierre diff/full-file rendering, split/unified and continuous/focused layouts, virtualization, highlighting workers, worker-based diff parsing, and tree preparation outside React.
- [x] Searchable Pierre tree, all/changed/unresolved filters, resizable sidebar, color-coded Git status and line totals, keyboard file search, and previous/next changed file and unresolved thread navigation.
- [x] Local line-range threads, replies, resolve/reopen, outdated thread access, Markdown, timestamps, comment deletion, and reviewed markers with automatic file collapse tied to content fingerprints. Versioned review records use serialized atomic writes and preserve unreadable files.
- [x] Nineteen Vitest checks cover settings, Git comparisons and persistence, including partially staged files, remote refs/merge bases, unusual names, CRLF, conflicts, linked worktrees, cancellation, stale content, large/binary files, and corrupt records.
- [x] TypeScript checks and production build pass. Playwright verifies both diff layouts, focused/continuous browsing, unchanged files, local threads/replies/resolution, reviewed markers, stale notes on refresh, themes, and restart persistence.
- [x] Reproducible opt-in desktop benchmark added (`pnpm run test:benchmark`). On macOS 26.3, Apple M1 Pro (10 cores, 16 GiB), a synthetic repository with 100,000 tracked files and 1,000 one-line TypeScript changes measured **819 ms to the first visible diff in continuous mode** and **24 ms cached focused-file navigation** (hidden-window run with Git status and line totals enabled). Browser-frame timing excludes fixture creation and Playwright actionability polling; this is a single local run, not a guarantee for larger files or other machines.
- [x] Usability follow-up: persisted drag/keyboard sidebar resizing, icon filter tabs, suggesting From/To controls with repeat-Compare refresh, project-selection modal, and a dedicated window-drag region.
- [x] Comment composers use side-specific line annotations without redundant side/range fields. App-lifetime highlighting workers are verified in production and Vite development, including repository switching.
- [x] Reviewed-revision content search covers commit/index/working-tree text, opens matching lines, validates mutable snapshots, and reports capped results explicitly.

**Milestone 2: implemented and verified on macOS arm64; Windows verification pending CI.**

- [x] Explicit managed-worktree and in-place preparation for pinned target commits; local-change reviews use the existing checkout. Index reviews materialize an immutable, isolated index tree and reject stale index snapshots.
- [x] Clean in-place checkout without a second confirmation; confirmation is required when tracked/untracked changes need stashing. Versioned, atomic workspace recovery records preserve the original branch/commit and exact stash identity across restarts, including interruption between stash creation and journal update.
- [x] Restore/leave/cancel prompts when changing comparisons or repositories and closing/quitting. Restoration preserves partial staging, refuses new changes and moved branches, retains the recovery stash, and exposes conflict/interruption recovery instructions with explicit manual-recovery completion.
- [x] Managed worktrees persist until explicit removal. Cleanup refuses tracked changes, non-ignored untracked files, and changed HEADs; ignored-file cleanup requires explicit confirmation; checkout protects ignored files from overwriting.
- [x] Settings modal with an Appearance/Workspace/Worktrees sidebar and switches for boolean preferences. A single user-configured post-checkout script for the current machine, global defaults and repository overrides, streamed output, failure reporting, retry, and process-tree cancellation. Repository files are never imported as setup commands.
- [x] Built-in launchers for Cursor, VS Code, IntelliJ IDEA, and WebStorm with file/line arguments. Selected target lines and search results carry line positions; per-file IDE split buttons remember the chosen launcher and open on-disk files even during historical/index comparisons, without requiring preparation. Paths resolving outside the active workspace are rejected.
- [x] All 41 Vitest checks pass, including new coverage for dirty worktrees, ignored output, partially staged/untracked restoration, independent user stashes, restart/crash recovery, failed checkout, conflicting restoration, manual recovery, stale-index isolation, script output/failure/cancellation, command preferences, legacy-settings migration, IDE path validation, tag/commit identity matching, and staged checkout matching.
- [x] TypeScript, Hooks lint, formatting, production build, and all eight enabled Playwright desktop tests pass locally. The desktop flow verifies preparation, setup output and retry, project/file IDE arguments, explicit cleanup in Settings, comparison-exit restoration, and matching-tag initialization. The opt-in benchmark is not rerun for this milestone.

**Milestone 3: implemented and verified with API fixtures and Electron on macOS arm64. Live GitLab and Windows validation pending.**

- [x] Settings → GitLab with instance URL, OS-encrypted personal access token, connection/version probe, optional PEM CA certificate, and explicit TLS-verification override. Tokens stay in the main process after submission.
- [x] Origin discovery for HTTP(S), SSH and nested projects; explicit hostname/path mismatch and SSH-alias errors. Clone URLs may use a different scheme or port from the configured API endpoint. Preserve branch names separately from immutable comparison IDs. Paginated open-MR lookup matches New/source, Old/target, and source project; ambiguous matches offer selection.
- [x] MR button beside Search, automatic comparison lookup, cached overlay opening, click-to-retry, lookup spinner, one-second red miss feedback, and stale-result protection when changing comparisons.
- [x] Right-side MR overlay with metadata, Markdown description, reviewers, labels, pipeline, approvals, discussions; replaces the planned MR metadata tab.
- [x] GitLab-version-based inline anchors with renamed paths and contextual line mapping; current inline discussions and unresolved navigation. All outdated/unplaced and general discussions remain accessible in the overlay.
- [x] General/inline comments, range-based suggestions, replies, permitted edits, resolve/reopen, direct posting, and approve/unapprove with the reviewed SHA. Shared GitLab/local composer defaults to GitLab when available, includes adjustable start/end lines, suggestions prefilled from the selected code, and a Post now / Cancel row. GitLab multiline positions cover the selected range.
- [x] Comments post directly; failures keep composer text, uncertain outcomes are never automatically retried, and local uploads remove the local comment only after confirmed success.
- [x] Focus-aware 60-second polling, focus/manual refresh, explicit new-revision banner and fetch/open action; revision and anchor validation before posting comments. Unaligned comparisons cannot approve or post inline.
- [x] TypeScript, Hooks lint, formatting, production build, Vitest checks, and Playwright desktop tests pass. Coverage includes lookup pagination/project matching, branch identity, changed MR heads, renamed paths, permissions, direct multiline posting, uncertain posting outcomes, the overlay/spinner/red flash, automatic and stale lookup, inline suggestions, approvals and unresolved navigation. The opt-in benchmark was not rerun. Installed tool entry points were used directly because pnpm registry-signature verification was unavailable in the execution environment.

**Milestone 4: implemented; protocol/service and Electron fixture verification on macOS arm64. Authenticated model-turn and Windows validation pending.**

- [x] Main-process Codex stdio adapter behind a small start/resume/send/cancel/approve harness interface, with protocol negotiation, actionable startup failures, streaming messages/tool activity, crash recovery, and persisted session identifiers. Uses installed authentication; tested local initialization and permission negotiation with Codex 0.146.0.
- [x] Settings → AI Scenarios provides persisted model and supported reasoning-effort choices for chat, code review, and review order, discovered from Codex. Choices apply to new/resumed sessions and review-order cache keys. A preferred response language applies to all AI tasks.
- [x] Collapsible and resizable Codex panel with independently running persisted chat tabs, per-tab drafts, hidden tool activity, reference attachments, explicit Review changes, cancellation, resume, and Enter-to-send. Panel width/preference, transcript, findings, and walkthrough sections persist.
- [x] Per-chat permission selector with Read only (default), Ask for approval, Approve for me (Codex automatic reviewer), and Full access. Background tasks remain read-only. Manual approvals stay outside the transcript, scoped to their chat; unsupported policies are rejected. Workspace and mutable-snapshot checks invalidate results after changed content; read-only chat and background tasks inspect Git comparison parameters without workspace initialization; staged editing creates/reuses an isolated index worktree.
- [x] Background code review validates structured findings against path, side, range, content fingerprint, and snapshot before automatically creating local comments authored by AI. Duplicate comments are skipped. Review status, errors, and cancellation are separate from chat; automatic prompts/results never enter the chat transcript. Standard local-comment controls provide editing, resolution, deletion, and explicit GitLab upload. AI never posts automatically.
- [x] File layout (Tree/List) and ordering (Filesystem/AI) have separate controls. Layout persists; reviews open in Filesystem order. AI Tree layout gives each section its own tree with unrestricted content height and sticky section headings. It lazily generates validated JSON sections in a separate, read-only background session; no generation messages or approval dialogs enter chat. Cached steps include rationale, file navigation, file-type icons, and Git status colors, and invalidate when comparison parameters or mutable content change. Mutable refreshes retain outdated findings, and new chat generations start separate sessions.
- [x] Versioned atomic AI persistence preserves unreadable records. Prompts contain comparison parameters and attachment references instead of diffs or file contents. Local anchor validation loads only files referenced by findings; explicit discussion attachments retain a 3 MiB request limit. Available MR metadata/discussions are supplied automatically in system instructions without fetched diffs.
- [x] All 131 Vitest checks, all 13 enabled Playwright desktop tests, TypeScript, Hooks lint, formatting, and production build pass on macOS arm64. New fixtures cover streaming, approvals, denied edits, cancellation, resume, crashes, malformed/unanchored findings, stale generations, local conversion, persistence, walkthroughs, staged isolation, dirty historical workspaces, and unborn repositories. Additional fixtures verify parameter-only prompts, legacy-session migration, hidden order generation, cache reuse/invalidation, and malformed sections. Desktop coverage exercises chat, approvals, cancellation, automatic local AI comments, independent chat/background review, lazy review order, section-based next/previous navigation, response language, persisted panel resizing, Enter/Shift+Enter, and restart persistence.

**Milestone 5: implemented and verified on macOS arm64; Windows validation pending.**

- [x] OpenCode v2 adapter using the official `@opencode/client` promise SDK with initialization/capability negotiation, installed authentication, models, session start/resume, streaming messages/tool activity, cancellation, failures, and manual tool approvals.
- [x] Settings → AI Scenarios selects a provider before model/effort independently for chat, code review, and review order. Existing chats apply provider changes on the next message, starting a new provider session with conversation history as context; saved session IDs are never passed between providers. Review-order cache keys include provider selection.
- [x] Settings → AI Providers has binary paths, automatic availability/model checks every five minutes, and preloaded reasoning choices for every model shared by all scenario selectors. Codex defaults and existing settings remain compatible.
- [x] OpenCode v2 receives its review agent through an in-memory configuration overlay, preserving installed configuration and authentication. Older versions are rejected before starting a server. Read only denies shell/edit tools and exposes constrained, shell-free Git reads through a local authenticated MCP tool. Ask for approval and Full access retain the shared chat approval UI. Automatic approval review is explicitly unsupported; background tasks remain read-only.
- [x] OpenCode JSON findings and walkthroughs use the existing snapshot/anchor validation, local comments, staleness handling, independent background sessions, and explicit GitLab publishing. Model JSON is requested and validated locally. OpenCode reasoning choices come directly from model metadata, with provider defaults otherwise.
- [x] Real OpenCode 2.0.18 initialization, model discovery, restricted-agent selection, and an authenticated Git-inspection model turn verified on macOS. Windows validation remains pending.

- [x] 155 deterministic Vitest checks, the OpenCode Playwright desktop flow, TypeScript, Hooks lint, formatting, and production build pass. The separate Codex desktop flow currently times out selecting a reasoning level; broader desktop validation is not fully green. Coverage includes provider routing/persistence/migration, SDK streaming, approvals and denial, cancellation, process failure, safe Git inspection, structured review/order, settings, and restart. Two opt-in live checks cover installed OpenCode startup/resume and an authenticated Git-inspection turn. Fixed the reproduced OpenCode 2.0.18 ACP catalogue startup race by using its authenticated local API for v2, waiting for agent discovery, and applying session permissions on create/resume. Model and reasoning metadata load directly without temporary discovery sessions. Native protocol regression tests cover delayed agents and MCP connections, missing agents, nested OpenRouter model IDs, streaming, approvals, cancellation, errors, and resume. Three consecutive live startup/resume checks selected Kimi K3, Opus 5.5, GPT-6 Astra, and DeepSeek V4 Flash through OpenRouter; a real DeepSeek Git-inspection turn also passed. No prompt is sent when agent selection fails. The SDK handles typed requests, errors, and SSE parsing; there is no legacy transport fallback. The opt-in benchmark was not rerun.

**Next: milestone 6, TypeScript intelligence.** Monaco remains the planned suggestion editor.

Implementation note: Electron Vite 5 currently requires Vite 5–7. Use Vite 7 with React plugin 5, rather than the incompatible latest Vite/React-plugin majors. Tests and scripts run with Node where required; Electron owns desktop runtime execution.

## 5. Validation and defaults

### Tests

- **Git integration:** temporary repositories covering merges, renames, unusual filenames, CRLF, untracked files, partially staged files, conflicts, worktrees, and stash restoration failures.
- **GitLab integration:** API fixtures for pagination, nested projects, outdated discussions, permission failures, changed MR heads, uncertain network outcomes, and direct posting. Validate against a designated test project before relying on production writes.
- **Harness integration:** recorded protocol fixtures plus manual smoke tests with installed Codex/OpenCode; cover approval denial, cancellation, process crashes, resume, malformed findings, and changed snapshots.
- **Language tooling:** project fixtures with imports, aliases, TSX, project references, missing dependencies, and replacement blocks that shift line numbers. Verify that source files remain unchanged.
- **UI:** Vitest for meaningful state/domain behavior and Playwright Electron tests for critical review flows. Exercise both supported operating systems.

### Performance targets

Benchmark a fixture with 100,000 tracked files and 1,000 changed files. On documented reference machines, target:

- First visible diff within three seconds of selecting a locally available comparison.
- Cached file navigation within 150 ms.
- Responsive scrolling while highlighting, GitLab refresh, and AI streaming run concurrently.

Exclude network fetches and dependency setup from those timings. Record measured results rather than treating targets as guarantees.

Files exceeding 1 MiB or 20,000 lines initially show a size summary and explicit load action. Keep metadata visible for every changed file.

### Explicit defaults and deferred work

- One active review per window, with recent repositories and reviews persisted.
- Support the team’s GitLab instance through API capability checks; establish its tested version during the GitLab milestone.
- Preserve TLS verification; support custom certificate configuration if the instance requires it, support ignoring TLS verification if the user wants to.
- Post-checkout scripts are configured by the user, never silently loaded and executed from a repository.
- No automatic GitLab posting by AI.
- Defer MR merging, full editing, automatic suggestion application, cross-project review inboxes, additional hosting providers, other language servers, signed distribution, and automatic updates.

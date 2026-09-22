# RevUI implementation plan

## 1. Product and scope

Build a local code-review application for developers on macOS and Windows. Start with a useful local diff viewer, then add GitLab collaboration, AI review, and TypeScript tooling.

Use Electron, React, TypeScript, shadcn/ui, Tailwind, `@pierre/diffs`, `@pierre/trees`, and pnpm. Initially, developers clone the repository and run setup commands; signed installers and automatic updates are deferred.

The app supports reading code, writing review comments, and composing suggestions. Direct source editing, staging, committing, pushing, and merging MRs are outside this plan. The terminal remains a normal shell under the user’s control.

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
- Persist drafts, local threads, reviewed-file progress, AI findings, walkthroughs, panel preferences, and harness session identifiers.

### Review interface

- A single top toolbar: repository selector, MR meta / review tabs, comparison controls (in review tab), and settings. Integrate native window controls into this row.
- Left (review tab): searchable file tree.
- Center (review tab): continuous multi-file diff by default, with a focused single-file mode.
- Center (MR meta tab): MR title, metadata, and approval action
- Right (both tabs): collapsible AI chat and review walkthrough.
- Bottom (both tabs): collapsible terminal.
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

- Ask whether to create an app-managed worktree or check out in place.
- For dirty in-place checkout, show an explicit stashing warning. Stash tracked and untracked changes, preserving the original checkout and exact stash identity.
- Block the operation if stashing or checkout fails; do not discard changes.
- Allow a user-configured post-checkout script, with repository overrides and separate macOS/Windows commands. Show execution output and failures.
- When leaving an in-place review, prompt to restore the original workspace or leave it as-is.
- Restore only the app’s recorded stash. Preserve it on conflicts and show recovery instructions; never force restoration over new changes.
- Retain managed worktrees until explicit cleanup. Check for user changes before removal.

Reviewing current local changes uses the existing workspace. For staged-only AI review, prepare an isolated snapshot matching the index so unstaged changes do not contaminate the review.

Use `xterm.js` and `node-pty` for terminal sessions rooted in the selected workspace. Provide configurable IDE launch commands with file/line arguments. Historical files require a matching prepared workspace or an explicitly labeled temporary snapshot.

### GitLab integration

Configure a self-hosted instance URL and personal access token. Infer project identity from `origin`, supporting HTTP, HTTPS, SSH URLs, nested groups, and `.git` suffixes. Surface ambiguous SSH aliases or instance mismatches rather than guessing.

List the inferred project’s open MRs, prioritizing the checked-out source branch. Resolve MR identity and canonical URL through GitLab; do not assume a branch identifies exactly one MR.

Implement:

- MR title, description, tags, author, reviewers, source/target branches, status, pipeline summary, and approval state.
- General comments, inline discussions, replies, resolved discussions, and outdated discussions.
- Create comments and suggestions, edit permitted comments, resolve/reopen threads, approve/unapprove.
- Per-comment **Post now** and **Save draft**, plus publishing selected drafts.
- Local-only AI findings until the user explicitly publishes them.

Use GitLab’s diff-version references and old/new paths and line positions for inline comments. Keep GitLab anchors distinct from local comparison anchors. Comments that cannot be placed accurately remain accessible in an outdated/unplaced discussion view. [Discussions API](https://docs.gitlab.com/api/discussions/)

Pin each MR review to its loaded revision. Poll the active MR every 60 seconds while focused, refresh on window focus, and provide manual refresh. New commits show an update banner; switching revisions is explicit.

Before publishing drafts, validate the current MR revision and comment anchors. Approval includes the reviewed head SHA so GitLab rejects stale approval. [Approval API](https://docs.gitlab.com/api/merge_request_approvals/)

Preserve drafts through offline periods and failures. Do not automatically retry an uncertain comment creation, which could duplicate a successful post. Report partial batch-publish results per comment.

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

Build Codex first using its stdio app-server interface, which supports embedded conversations, streaming events, and approvals. Add OpenCode through ACP afterward. Keep provider-specific behavior inside adapters rather than building a general plugin framework. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [OpenCode ACP](https://opencode.ai/docs/acp/)

Reuse installed harnesses and their existing authentication. Show actionable setup errors when a harness is missing or incompatible.

AI features:

- Chat scoped to the repository and active review, with attachments for selected lines, files, threads, and MR context.
- Explicit **Review changes** and **Suggest review order** actions.
- Findings containing severity, explanation, path, side, line range, and optional replacement code.
- A grouped walkthrough of related files/hunks with rationale and completion state.
- Accept, dismiss, edit, and convert findings into local threads or GitLab drafts.

Request structured review results and validate them against the snapshot before displaying actionable annotations. Invalid or unanchored output remains visible as text, never as a fabricated inline finding. Do not change the user’s review order automatically.

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

| Milestone | Deliverable and completion criteria |
|---|---|
| **0. Foundation** | Save `plan.md`; scaffold Electron/React/pnpm; establish IPC, settings, themes, and test tooling. Confirm startup and native terminal dependencies on macOS and Windows. |
| **1. Local review** | Open/reopen repositories; implement all comparison modes, both layouts, tree filters, local threads, reviewed markers, and lazy diff loading. Usable offline without GitLab or AI installed. |
| **2. Workspace tools** | Add worktree/in-place preparation, safe stash restoration, post-checkout scripts, IDE opening, and terminal sessions. Verify failure recovery before enabling GitLab-driven workspace preparation. |
| **3. GitLab review** | Add token setup, `origin` discovery, MR selection/metadata, all discussion workflows, suggestions, immediate/draft publishing, refresh handling, and approval. A complete human MR review can happen in the app. |
| **4. Codex review** | Add chat, approvals, cancellation/resume, structured findings, publishing selected findings, and grouped walkthroughs. Results remain tied to the reviewed snapshot. |
| **5. OpenCode** | Add the ACP adapter and run the same chat/review acceptance scenarios. Surface capability differences explicitly. |
| **6. TypeScript intelligence** | Add target-side hovers/definitions and contextual suggestion completion/diagnostics without source writes. |
| **7. Team readiness** | Complete monorepo benchmarks, accessibility and keyboard checks, recovery testing, onboarding documentation, and macOS/Windows setup verification. |

Each milestone ends with a usable application, relevant automated checks, and an updated `plan.md`. Performance work happens throughout rather than being postponed to milestone 7.

### Implementation status — September 22, 2026

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
- [x] Native node-pty shell smoke test passes under Electron on macOS arm64. Setup uses shipped Node-API prebuilds and repairs the macOS helper executable permission.
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

**Next: milestone 2, workspace tools.** MR, AI, and terminal controls remain omitted until their integrations are functional. Monaco remains the planned suggestion editor in milestone 6.

Implementation note: Electron Vite 5 currently requires Vite 5–7. Use Vite 7 with React plugin 5, rather than the incompatible latest Vite/React-plugin majors. Tests and scripts run with Node where required; Electron owns desktop runtime execution.

## 5. Validation and defaults

### Tests

- **Git integration:** temporary repositories covering merges, renames, unusual filenames, CRLF, untracked files, partially staged files, conflicts, worktrees, and stash restoration failures.
- **GitLab integration:** API fixtures for pagination, nested projects, outdated discussions, permission failures, changed MR heads, uncertain network outcomes, and partial publishing. Validate against a designated test project before relying on production writes.
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

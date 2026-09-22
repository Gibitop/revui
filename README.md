# RevUI

A local code-review workspace for macOS and Windows. See [plan.md](plan.md) for the roadmap and implementation status.

Local review is implemented: open repositories, compare commits or local changes, browse diffs and full files, and save local threads and reviewed markers. It works offline with the installed Git CLI. GitLab, AI, workspace preparation, and interactive terminals remain later milestones.

The shell has one toolbar and a monochrome palette. Color is reserved for semantic information such as added/deleted lines. Typography is limited to three styles: UI text (Geist, 400), labels (Geist, 600), and paths/code (Geist Mono, 400), all at 13px/20px with normal letter spacing and no text transforms.

## Run locally

Install Node.js 24 LTS, pnpm 11.25.0, and Git. On Windows, install Git for Windows and make Git available on `PATH`. Use native PowerShell or Command Prompt; WSL is not the desktop runtime.

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm run dev
```

`setup` ensures Electron is downloaded, prepares node-pty's bundled native binaries, and restores the executable bit on its macOS helper when needed. The supported macOS/Windows architectures have Node-API prebuilds, so a C++ toolchain is normally unnecessary. If you need a source build, install Xcode Command Line Tools on macOS, or Python and Visual Studio C++ build tools on Windows, then run `pnpm run rebuild:native` followed by `pnpm run setup`.

To run a production build:

```sh
pnpm run build
pnpm run start
```

Open a repository with the folder picker or **Cmd/Ctrl+O**. Open preferences with **Cmd/Ctrl+,**. Selecting a nested folder opens its Git working-tree root. Opening a repository does not check out, stage, or modify files.

## Local review

Click the project name (or **Cmd/Ctrl+O**) to open a repository dialog. Choose a recent project, or **Add repository** to open the system folder picker. The top toolbar leaves a dedicated empty area for dragging the window.

The repository opens its last comparison. **From** is the revision being reviewed; **To** is its baseline. Both fields suggest local branches, remote-tracking branches, tags, and recent commits, and accept typed refs or hashes. Use **Uncommitted → HEAD** for all local changes, **Index → HEAD** for staged changes, or **Uncommitted → Index** for unstaged changes. A commit can also be the baseline for Index or Uncommitted. Press **Compare** to load or refresh, including when the values have not changed. **Merge-base** is available when both revisions are commits. Commits and index blobs remain pinned within a loaded comparison.

The sidebar's icon tabs select **Changed files**, **All files**, or **Unresolved threads**. All files shows the reviewed revision plus paths deleted in the active diff. Select an unchanged file to read its full content. Search paths with **Cmd/Ctrl+P**. Drag the divider between the sidebar and code; it also supports left/right arrows when focused. Its width persists. Hide the sidebar with the panel button or drag its divider to the left edge; the Show file sidebar button restores it at its previous width. The collapsed state also persists. Use **Alt+Up/Down** for previous/next changed file and **Alt+Shift+Up/Down** for previous/next unresolved thread. The tree supports arrow-key navigation. Global Settings contains layout tab groups for split/unified diffs and continuous/focused review; these choices apply across repositories and persist. Enable **Wrap long lines** in Settings to wrap code in both diffs and full-file views.

**Search file contents** (**Cmd/Ctrl+F**) searches text in the reviewed revision, including unchanged files and non-ignored untracked files for Uncommitted. Matching is literal and case-insensitive. Select a result to open and highlight its line, including lines outside the initial viewport. Results show up to 500 matches; `500+` means the search should be narrowed. Binary files and submodule contents are excluded. Changed local content asks you to compare again.

Click or drag line numbers to select a comment range. A compact composer opens directly below that range; in split mode it stays on the selected side. The range and side come from the selection. Threads, replies, resolution state, and reviewed markers are local to the comparison. Unresolved notes remain accessible through the Unresolved threads tab, including files absent from the comparison. When content changes, earlier threads become outdated and reviewed markers no longer count as current. Reopening the same comparison restores unchanged notes and progress. Local comments render Markdown, show per-comment relative update times with full dates on hover, and can be deleted individually. Deleting the last comment removes its thread. File headers include a copy button for the repository-relative path and collapse or expand the diff; marking a file Reviewed collapses it. The tree and headers display color-coded Git status, and the sidebar includes added/deleted text-line totals.

Metadata loads before file content. Diff parsing, tree preparation, and highlighting run in workers; the diff and tree components virtualize their rendered rows. Files over 1 MiB or 20,000 lines require **Load complete file**. Binary/non-UTF-8 files receive a summary, symlinks show their target without following it, submodules show their reference/working-tree status, conflicts are labeled explicitly, and executable-mode changes remain visible. Errors do not silently truncate or discard files. Index snapshots remain pinned if Git staging changes; working-tree reads detect changes and ask for a refresh.

Review records live in versioned JSON under `userData/reviews/<repository hash>/<comparison hash>.json`; the last comparison is stored alongside them. Writes are serialized and atomic. Unreadable or unsupported records are left untouched and editing them is blocked with an error. This application never checks out or edits repository source while browsing.

## Checks

```sh
pnpm run check          # TypeScript + Vitest
pnpm run test:native    # Spawn a shell through node-pty inside Electron
pnpm run test:e2e       # Build + Playwright desktop review tests
pnpm run test:benchmark # Opt-in 100,000-file / 1,000-change desktop measurement
```

Desktop tests require a graphical desktop session. They use temporary repositories and isolated settings directories, not your normal app preferences. Playwright uses the installed Electron binary; a separate browser download is not required.

The GitHub Actions workflow runs the same checks on macOS and Windows. Windows execution is pending the first CI run; local validation was performed on macOS arm64.

## Code layout

- `src/main`: privileged desktop services, repository inspection, Git comparisons, local review persistence, settings, and IPC handlers.
- `src/preload`: the narrow bridge exposed as `window.desktop`.
- `src/shared`: IPC names and desktop types; no privileged code or runtime dependencies.
- `src/renderer/src`: React workspace, shadcn-style UI primitives, themes, Query state, and Zustand UI state.
- `scripts`: desktop setup and native-module verification.
- `tests`: Electron end-to-end tests.

Electron owns the desktop runtime; development tools run with Node.js, and pnpm manages packages and scripts. Keep Vite on the major supported by Electron Vite (currently 7), with the matching React plugin (currently 5). `pnpm-lock.yaml` records the complete dependency graph. Dependency build scripts are explicitly allowed in `pnpm-workspace.yaml` for Electron, esbuild, and node-pty.

Preferences are stored in `settings.json` under Electron's `userData` directory. Writes are serialized and atomic; unreadable files are preserved with an `invalid` filename before defaults are loaded. A file from an unknown schema version is left untouched and startup stops with an explanation.

In development, `REVUI_USER_DATA` can point to an existing temporary directory to isolate app data. The renderer is sandboxed, cannot access Node directly, and only receives explicitly exposed IPC methods. Production builds use a restrictive Content Security Policy; development additionally permits Vite's refresh preamble and local HMR websocket.

Third-party licenses for installed packages are included under their respective `node_modules` directories. UI primitives follow shadcn/ui's Radix composition pattern and are owned by this application.

Electron E2E tests use hidden windows (`REVUI_TEST_HIDDEN=1`) with background throttling disabled. Electron still requires a graphical session; on Linux CI, run under Xvfb. The packaged app ignores this test flag.

Development watches main and preload modules as well as the renderer. Restart any existing dev process once after updating the dev command to pick up `--watch`.

# RevUI

A local code-review workspace for macOS and Windows. See [plan.md](plan.md) for the roadmap and implementation status.

The foundation is implemented: Electron/React, a repository picker and recent repositories, persisted preferences, light/dark/system themes, and the IPC boundary. Git diffs, discussions, GitLab, AI, and interactive terminal sessions are subsequent milestones. Their controls appear when those features are implemented.

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

## Checks

```sh
pnpm run check          # TypeScript + Vitest
pnpm run test:native    # Spawn a shell through node-pty inside Electron
pnpm run test:e2e       # Build + Playwright desktop smoke test
```

Desktop tests require a graphical desktop session. They use temporary repositories and isolated settings directories, not your normal app preferences. Playwright uses the installed Electron binary; a separate browser download is not required.

The GitHub Actions workflow runs the same checks on macOS and Windows. Windows execution is pending the first CI run; local validation was performed on macOS arm64.

## Code layout

- `src/main`: privileged desktop services, repository inspection, settings, and IPC handlers.
- `src/preload`: the narrow bridge exposed as `window.desktop`.
- `src/shared`: IPC names and desktop types; no privileged code or runtime dependencies.
- `src/renderer/src`: React workspace, shadcn-style UI primitives, themes, Query state, and Zustand UI state.
- `scripts`: desktop setup and native-module verification.
- `tests`: Electron end-to-end tests.

Electron owns the desktop runtime; development tools run with Node.js, and pnpm manages packages and scripts. Keep Vite on the major supported by Electron Vite (currently 7), with the matching React plugin (currently 5). `pnpm-lock.yaml` records the complete dependency graph. Dependency build scripts are explicitly allowed in `pnpm-workspace.yaml` for Electron, esbuild, and node-pty.

Preferences are stored in `settings.json` under Electron's `userData` directory. Writes are serialized and atomic; unreadable files are preserved with an `invalid` filename before defaults are loaded. A file from an unknown schema version is left untouched and startup stops with an explanation.

In development, `REVUI_USER_DATA` can point to an existing temporary directory to isolate app data. The renderer is sandboxed, cannot access Node directly, and only receives explicitly exposed IPC methods. Production builds use a restrictive Content Security Policy; development additionally permits Vite's refresh preamble and local HMR websocket.

Third-party licenses for installed packages are included under their respective `node_modules` directories. UI primitives follow shadcn/ui's Radix composition pattern and are owned by this application.

# Team setup and validation

RevUI is run from source. Local Git review works without GitLab, an AI provider, project dependencies, or workspace initialization. Signed installers and automatic updates are not available.

## First review on macOS

1. Install the version in `.nvmrc` (Node 24.18 or newer) and pnpm 11.25.0. With nvm, run `nvm install` and `nvm use` in this repository. Verify `node --version`, `pnpm --version`, and `git --version`. If macOS asks for command-line developer tools when running Git, complete that installation first.
2. Run `pnpm install --frozen-lockfile`, `pnpm run setup`, and `pnpm run dev` from a terminal in the cloned repository. Keep that terminal open. For a production build, run `pnpm run build` followed by `pnpm run start`.
3. Press **Cmd+O**, then **Open folder…** and select a Git repository. Opening a repository only reads it. Use **Edit comparison** to choose Old `HEAD` / New `Uncommitted`, `HEAD` / `Index`, or two refs; select **Compare**.
4. Navigate files, select line numbers to add a local comment, and mark a file reviewed. Close and reopen the repository to verify the saved notes. Use **Cmd+,** to choose theme, split/unified diffs, and continuous/focused browsing.
5. For TypeScript navigation, initialize with the lightning bolt. If reviewing another revision, prefer a managed worktree. Configure any dependency-install/build script yourself under Settings → Workspace. Setup is optional for browsing and read-only AI review. Cmd-click a target-side symbol to navigate after setup succeeds.
6. Optionally configure your team's GitLab instance in Settings → GitLab and your installed AI harness in Settings → AI Providers. See the [README](../README.md#gitlab-review) for authentication and permissions. Validate GitLab writes in a designated test project first. Review the target revision before publishing local or AI comments.

On Windows, use Git for Windows and native PowerShell/Command Prompt; the desktop app does not run inside WSL. Use Ctrl instead of Cmd. IDE command-line launchers must be installed and discoverable by the app. If a provider is not on the inherited terminal PATH, enter its full executable path in Settings → AI Providers.

## Keyboard and accessibility

| Action                            | Shortcut/control                      |
| --------------------------------- | ------------------------------------- |
| Open repository / settings        | Cmd/Ctrl+O / Cmd/Ctrl+,               |
| Search file paths / contents      | Cmd/Ctrl+P / Cmd/Ctrl+F               |
| Previous/next changed file        | Alt+Up / Alt+Down                     |
| Previous/next unresolved thread   | Alt+Shift+Up / Alt+Shift+Down         |
| Toggle file sidebar               | Shift+F, outside text inputs          |
| Resize a panel                    | Tab to its separator, then Left/Right |
| Settings sections                 | Up/Down on the section tabs           |
| Chat selection                    | Left/Right, Home/End on chat tabs     |
| Send chat / newline               | Enter / Shift+Enter                   |
| Close a dialog or semantic picker | Escape                                |
| Semantic navigation / references  | Cmd/Ctrl-click / Cmd/Ctrl+Shift-click |

Dialogs trap focus and restore it on dismissal; review navigation shortcuts yield to dialogs and editors. The selected chat's close button is beside the chat tabs. The automated accessibility test audits rendered review, settings, search, and AI surfaces in both themes with axe WCAG A/AA rules, including open shadow roots, and checks focus containment, restoration, tabs, search and keyboard resizing. It attaches complete audit results, including checks requiring human judgment. Electron uses axe's single-page mode because it cannot create a separate aggregation page.

These checks do not certify full WCAG compliance. VoiceOver/NVDA reading order, spoken diff semantics, all syntax grammars, and pointer-free line-range composition still need manual evaluation. To repeat the manual check: enable the platform screen reader, open a changed TS file, traverse the toolbar/tree/diff, open and dismiss settings/search, and verify announced names, selected states and focus location. Test large text and both themes at the app's minimum window size. Record failures with the affected control and reproduction steps.

## Recovery

Before manually repairing app data, quit RevUI and copy its data directory. Default locations are `~/Library/Application Support/RevUI` on macOS and `%APPDATA%/RevUI` on Windows; `REVUI_USER_DATA` overrides the location for development/tests. This directory can contain private review text and encrypted credentials; redact it before sharing diagnostics.

| Symptom                                                     | Recovery                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupted in-place preparation/restoration                | Open Settings → Worktrees. Inspect the recorded original branch/commit, exact stash SHA and current `git status` before changing anything. Do not apply a stash twice. Restore manually if requested, then choose **I restored manually…**. RevUI retains its stash as a recovery copy. |
| New work or original branch moved                           | RevUI refuses automatic restoration. Preserve your new work and reconcile the branch manually. Never use a force checkout or reset merely to dismiss the warning.                                                                                                                       |
| Setup failed/canceled                                       | Inspect output, fix the configured command, then retry initialization. The managed worktree remains available.                                                                                                                                                                          |
| Corrupt settings                                            | The original is renamed to an `invalid` backup and defaults load with a warning. Keep the backup for diagnosis.                                                                                                                                                                         |
| Unsupported schema or unreadable review/AI/workspace record | The app preserves the original and blocks the affected operation. Back up the file; use a compatible application version or repair a copy. Do not delete `workspaces.json` while an in-place recovery is pending.                                                                       |
| GitLab comment creation timed out                           | Refresh GitLab and inspect whether the comment exists before retrying. An uncertain creation is never automatically retried; local notes remain until confirmed uploaded.                                                                                                               |
| Harness stopped or comparison changed                       | Reopen/resume chat or retry the background review after inspecting the error. Refresh changed local contents; outdated findings/notes must not be treated as current annotations.                                                                                                       |
| Electron is missing                                         | Re-run `pnpm run setup`. Check proxy/network errors from the Electron download.                                                                                                                                                                                                         |
| pnpm registry/signature failure                             | Resolve registry connectivity and package-manager trust configuration, then retry the frozen install. Do not disable verification or regenerate the lockfile as a workaround.                                                                                                           |

The deterministic suites exercise stash identity and partial staging across restart, conflicting/interrupted restoration, moved branches, crash-after-apply recovery, failed writes, corrupted/unsupported records, provider failures/cancellation, stale snapshots and uncertain GitLab posting. Desktop tests use isolated application-data directories and temporary repositories.

## Reproduce the readiness checks

```sh
pnpm run check
pnpm run test:e2e
pnpm run test:benchmark
```

The desktop suite requires a graphical session and uses the installed Electron binary, with no separate browser download. The CI workflow runs deterministic and desktop checks on macOS and Windows; POSIX harness fixtures explicitly skip Windows, so native Windows harness validation remains a separate task. Live AI tests are opt-in and require authentication; normal CI never sends model prompts or writes to a live GitLab server.

The opt-in benchmark creates a temporary synthetic monorepo with 100 packages, 100,000 tracked files (99,900 forty-line TypeScript files plus 100 manifests), and 1,000 changes spread across packages. It measures a single comparison submission through the first rendered diff, then navigation back to a cached file. It also scrolls for six seconds while real highlighting workers run, synthetic AI state arrives at 20 Hz, and the normal GitLab focus-refresh handler receives 100-discussion fixture responses twice per second. Counters confirm those workloads actually ran. Fixture creation, setup, network access and Playwright actionability polling are outside the timing window. JSON attachments record the host, timestamp, timings and frame gaps.

Targets: first visible diff <3,000 ms, cached navigation <150 ms, scrolling p95 frame gap <100 ms and no frame gap ≥1,000 ms. These are regression checks for the documented fixture, not guarantees for every project or machine. Run benchmarks alone on an idle machine; compare multiple runs with the same fixture. Real network/model latency and sustained hours-long memory behavior are not represented.

## Validation record

The [recorded macOS run](benchmarks/2026-09-27-macos-arm64.json) measured 1,830 ms to the first diff, 9 ms cached navigation, and scrolling frame gaps of 60 ms at p95 / 91 ms maximum (115 AI updates and 12 GitLab refreshes). All targets passed on macOS 26.3, Apple M1 Pro, 10 cores, 16 GiB. This single run uses a hidden Electron window with background throttling disabled.

See [milestone 7 in the plan](../plan.md) for full-suite results and remaining manual/platform validation. Keep that record honest when repeating checks: record the OS/architecture, commands, pass/skip counts, timings, and any failed or untested scenario. Live GitLab validation and native Windows/assistive-technology checks require their respective environments.

## Related issue

[OMNI-3247 — Update in-chat error message patterns](https://linear.app/omnigent/issue/OMNI-3247/update-in-chat-error-message-patterns)

## Summary

- Replaces shared in-chat errors with a compact destructive banner that expands into a labeled Message section and Terminal / Last captured output diagnostics, with safe wrapping, bounded scrolling, copy feedback, local-only Dismiss, and accessible retry failure handling.
- Adds a payload-free `retry_session` recovery control with per-session server single-flight. It distinguishes already-live no-ops from real recovery, relaunches dead runners once, recreates a missing required native terminal, and never replays the failed request.
- Returns typed, non-persisting workspace-missing and harness-refusal failures, trims Retry to recovery-capable codes, keeps diagnostics tabs valid, suppresses unavailable-output sentinels, and preserves message/error history during recovery.
- Synced the branch with `upstream/main` at `bee2b7518e7f98f227184903b61dd94086ea45f5`; the current signed head is `44ff5ab738ed3d4e0051c84335519c39934941ac`.

**ELI5:** Errors stay compact until opened. Retry repairs the existing session only when the server can prove it became usable, without resending the user's message or adding recovery noise to message history.

```text
persisted error item
        |
        v
shared ErrorBanner --expand--> Message + diagnostics tabs
        |
        +-- Retry --> per-session single-flight
        |                |
        |                +-- live runner, usable ----------> no-op; banner stays
        |                +-- dead runner ------------------> relaunch once
        |                +-- missing native terminal ------> ensure once
        |                +-- workspace/harness refusal ----> typed failure
        |
        +-- Dismiss --> hide this banner locally

No path replays input or persists the retry control as a message/error item.
```

## Test Plan

- Merged current `upstream/main` (`bee2b7518e7f98f227184903b61dd94086ea45f5`) with `git merge --no-edit --signoff upstream/main`; the merge was conflict-free and the merge commit author, committer, and `Signed-off-by` email all match `36802691+zhengwin@users.noreply.github.com`.
- Focused backend recovery suite — 13 passed. Covers live-runner no-op, dead-runner relaunch, concurrent retry single-flight, one binding rotation, workspace missing (410), harness refusal (412), required native-terminal recreation, transient resource-event history preservation, and existing runner ensure routing.
- Full frontend Vitest suite — 5737 passed, 3 expected failures, 1 skipped.
- Focused `StatusBlocks.test.tsx` + `BlockRenderer.test.tsx` suites — 100 passed.
- `pnpm --filter web run type-check` — passed.
- `pnpm --filter web run lint` — passed.
- `pnpm --filter web run format:check` — passed.
- Focused Ruff format/lint checks for all changed backend files — passed.
- `git diff --check` — passed.
- `pre-commit run --all-files` — every hook passed, including Ruff, Pyrefly, Prettier, Oxlint, TypeScript, protobuf freshness, and repository hygiene checks.
- Real three-process worktree stack (`omnigent server --port 6868`, host, Vite `:5273`) re-exercised current-base recovery. Two concurrent retries returned the same `runner_relaunched` result, produced one host launch and one binding rotation; a subsequent retry returned `already_connected` without replaying input.
- Exact native-terminal probe: after dead-runner relaunch, deleting `terminal_claude_main` changed terminal count `1 → 0`; retry returned `native_terminal_ready`, restored exactly one terminal (`0 → 1`), kept the runner binding unchanged, and left the complete item payload byte-for-byte unchanged (`11 → 11`).
- Workspace-missing and harness-refusal retries returned typed HTTP 410 / 412 responses with byte-for-byte unchanged item lists.
- Real browser verification covered light, dark, and 430px layouts; compact one-line truncation; expanded wrapping; visible Retry/Dismiss actions; diagnostics tabs and clipboard contents; unavailable-output suppression; keyboard disclosure with retained focus; assertive retry failure announcement; Dismiss focus after failure; local-only Dismiss; scrolling; alignment; spacing; no horizontal overflow; and contrast.
- Two same-tick Retry clicks remain synchronously guarded by focused component coverage.

## Demo

### Light theme — 430px compact truncation

![Light compact error pattern](https://raw.githubusercontent.com/zhengwin/omnigent/omni-3247-error-patterns-demo-20260814/demo/omni-3247-430-light-collapsed.png)

### Light theme — 430px expanded wrapping and diagnostics

![Light expanded error pattern](https://raw.githubusercontent.com/zhengwin/omnigent/omni-3247-error-patterns-demo-20260814/demo/omni-3247-430-light-expanded.png)

### Dark theme — 430px expanded wrapping and diagnostics

![Dark narrow expanded error pattern](https://raw.githubusercontent.com/zhengwin/omnigent/omni-3247-error-patterns-demo-20260814/demo/omni-3247-430-dark-expanded.png)

### Dark theme — retry failure and Dismiss focus

![Dark retry failure pattern](https://raw.githubusercontent.com/zhengwin/omnigent/omni-3247-error-patterns-demo-20260814/demo/omni-3247-430-dark-retry-failure.png)

### Dark theme — wide layout

![Dark wide expanded error pattern](https://raw.githubusercontent.com/zhengwin/omnigent/omni-3247-error-patterns-demo-20260814/demo/omni-3247-wide-dark-expanded.png)

Updated demo assets are on temporary branch `omni-3247-error-patterns-demo-20260814` at `3be524dbc0676f0a3246e050b5261dd49a070de2`, keeping the PR diff source-only. The branch can be deleted after merge.

## Type of change

- [x] Bug fix
- [x] Feature
- [x] UI / frontend change
- [ ] Refactor / chore
- [ ] Docs
- [ ] Test / CI
- [ ] Breaking change

## Test coverage

- [x] Unit tests added / updated
- [x] Integration tests added / updated
- [ ] E2E tests added / updated
- [x] Manual verification completed
- [x] Existing tests cover this change
- [ ] Not applicable

## Coverage notes

Manual verification used the current-base worktree server, host, real runners, and Vite frontend. Backend probes asserted typed status codes, shared concurrent outcomes, one actual host launch, one binding rotation, live-runner no-op behavior, native-terminal recovery, and unchanged message/error history for workspace deletion and harness refusal. Browser checks used persisted retryable and non-retryable error fixtures in light, dark, wide, and 430px layouts. A granted headless clipboard verified the exact Message and Last captured output text; focused component tests additionally cover accessible copy confirmation and dynamic diagnostics-tab fallback.

## Changelog

In-chat errors now provide expandable diagnostics and recovery-aware Retry, copy, and dismiss actions without replaying failed input.

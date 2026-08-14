## Related issue

[OMNI-2901: Composer covers viewport](https://linear.app/omnigent/issue/OMNI-2901/composer-covers-viewport)

## Summary

- Keep the growing composer in normal flex layout so multiline prompts reduce the transcript viewport instead of covering chat output.
- Preserve bottom lock and the reader's real scrolled-up distance when transcript output and composer growth happen sequentially, in the same rendering frame, or during an active restore window.
- Reconcile transcript-height changes before resize restoration while distinguishing genuine wheel, keyboard, pointer, and touch-momentum scrolling from library clamps.
- Re-sync local reader state from legitimate library bottom re-locks so the scroll-to-bottom button and send-scroll cannot be overwritten by a stale escaped distance.
- Keep touch-driven user intent active after `pointerup` through `scrollend`, with a debounce from the last scroll as fallback, so inertial scrolling adopts its final settled distance.
- Add unit and Chromium regression coverage for composer reflow, focus, streaming, simultaneous output/composer growth, button/send re-locks, touch momentum, and output clearance.

**ELI5:** the composer now claims its own space instead of growing over the conversation. Readers stay where they chose—even if output and the composer change together, they explicitly return to the bottom, or a touch scroll keeps moving after the finger lifts.

```text
Before: [ transcript ---------------- ]
                              [ composer overlaps ↑ ]

After:  [ transcript -------- ]
        [ composer in flow --- ]
```

## Test Plan

- `pnpm test -- src/pages/ChatPage.composer.test.tsx src/hooks/useAutoGrowTextarea.test.tsx`
  - 284 test files passed, 1 skipped; 5,702 tests passed, 3 expected failures, 1 skipped in 48.13s.
- `.venv/bin/pytest -q tests/e2e_ui/chat/test_composer_growth_transcript_stability.py`
  - Final complete Chromium sequence passed in 21.12s, then passed three consecutive deterministic runs in 22.12s, 23.11s, and 27.30s.
  - RED on the prior head: at `500×713`, touch momentum settled at `650px`, then composer growth restored stale `500px`.
  - GREEN: pointer-down distance `500px`, post-release momentum `650px`, and composer growth `650→650px`, with `0px` overlap and composer focus retained.
  - Also covers bottom lock, sequential streamed output, same-frame output plus composer growth, output appended during restoration, the first genuine user scroll, scroll-button re-lock, send re-lock, appended bottom-follow, and subsequent focus/input behavior.
- `pnpm type-check && pnpm lint && pnpm build`
  - Passed. Production build completed in 3.52s; existing CSS `::highlight` optimizer and large-chunk warnings remain unchanged.
- `.venv/bin/pre-commit run --all-files`
  - All hooks passed.
- Verified the real three-process stack on the mandated ports: `curl http://localhost:6767/health` returned `{"status":"ok"}`, the host registered and listened for sessions, and the feature frontend returned HTTP 200 at `http://localhost:5173`.
- Manual Chromium matrix in both light and dark themes:
  - Standard `1200×800`: `0px` overlap and `24/24px` horizontal insets.
  - Narrow `500×713`: `0px` overlap and `16/16px` horizontal insets.
  - Short-height `1000×433`: `0px` overlap and a scrollable transcript.
  - Same-frame streaming: `180px → 542px` (expected `542px`) with `0px` overlap; output during the restore window retained its delta.
  - First genuine post-growth user scroll remained `748→748px` across composer growth.
  - Scroll-button re-lock remained `400px → 1px`; composer growth and appended output stayed at `1px`.
  - Multiline-send re-lock remained `320px → 1px`; the next draft growth stayed at `1px` and restored input focus.
  - Touch momentum in narrow light and dark: `500px → 650px → 650px` after composer growth, `0px` overlap, focus retained, `16/16px` insets.

## Demo

### Before (main)

Exact unfixed base `c4dd03c47c9c24a3067bc2eea127e1d832b49049`, `1200×800`, light theme. The transcript bottom remains at `675px` while the expanded composer top moves to `488px`, so the composer covers `187px` of the transcript and hides the final output.

![Before main: 187px transcript overlap](https://raw.githubusercontent.com/zhengwin/omnigent/OMNI-2901-evidence/tmp-evidence/omni-2901/before-main-annotated.png)

### After (this PR)

At the same representative viewport, the transcript reflows to meet the expanded composer with `0px` overlap; the final response remains visible above the card.

![After PR: zero overlap](https://raw.githubusercontent.com/zhengwin/omnigent/OMNI-2901-evidence/tmp-evidence/omni-2901/after-pr-annotated.png)

Light/dark interaction video, accelerated to 37 seconds:

[composer reflow demo](https://github.com/user-attachments/assets/ef047c19-8997-4487-b304-5958156407b1)

### Sequential streamed-output scenario

The reader scrolls up, output is appended below without moving the scroll container, the reader makes the first genuine post-growth scroll, and then the composer grows. The page preserves the selected distance and maintains `0px` overlap.

![After PR: appended output and scrolled-up distance preserved](https://raw.githubusercontent.com/zhengwin/omnigent/OMNI-2901-evidence/tmp-evidence/omni-2901/after-p1-annotated.png)

### Same-frame streamed-output scenario

Output growth and composer growth occur together, then another output chunk arrives during the active restore window. The fixed page reconciles both content deltas before restoring: `180px` becomes the expected `542px`, stays exactly `542px`, focus remains in the composer, and overlap remains `0px`.

![After PR: same-frame stream and composer distance preserved](https://raw.githubusercontent.com/zhengwin/omnigent/OMNI-2901-evidence/tmp-evidence/omni-2901/same-frame-round2.png)

### Library re-lock scenarios

After escaping the transcript, both supported library re-lock paths remain authoritative across subsequent composer resizing. The visible scroll-to-bottom button restores `400px → 1px`, a multiline send restores `320px → 1px`, appended output continues following, input focus returns, and overlap remains `0px`.

![After PR: button and send bottom re-locks remain active](https://raw.githubusercontent.com/zhengwin/omnigent/OMNI-2901-evidence/tmp-evidence/omni-2901/relocks-round3.png)

### Touch-momentum scenario

At the real narrow `500×713` viewport, the pointer moves the reader to `500px`, post-release inertia settles at `650px`, and composer growth preserves `650→650px`. Both themes retain focus, symmetric `16/16px` insets, and `0px` overlap.

![After PR: touch momentum preserved in narrow light and dark themes](https://raw.githubusercontent.com/zhengwin/omnigent/OMNI-2901-evidence/tmp-evidence/omni-2901/touch-momentum-round4.png)

## Type of change

- [x] Bug fix
- [ ] Feature
- [x] UI / frontend change
- [ ] Refactor / chore
- [ ] Docs
- [ ] Test / CI
- [ ] Breaking change

## Test coverage

- [x] Unit tests added / updated
- [ ] Integration tests added / updated
- [x] E2E tests added / updated
- [x] Manual verification completed
- [ ] Existing tests cover this change
- [ ] Not applicable

## Coverage notes

The unit regression prevents composer growth from returning to negative-offset overlay behavior. The Chromium regression verifies real geometry for reflow and bottom lock, sequential output growth, output/composer growth in one observer window, output appended during restoration, the first genuine user-selected distance, and both legitimate library re-lock paths (`ConversationScrollButton` and `ScrollToBottomOnSend`).

The final review regression adds a deterministic narrow touch sequence: pointer-down scrolling records `500px`, momentum after `pointerup` settles at `650px`, and later composer growth must preserve `650→650px`. The fix keeps intent only after the pointer actually moved the scroller, prefers `scrollend`, and uses a debounce from the last scroll when `scrollend` is unavailable or delayed. Each trailing momentum scroll updates the stored distance and cancels active restoration through the same user-scroll path as wheel and keyboard input. Listener and timer cleanup remain scoped to the existing effect, and bounded restore retries remain unchanged.

Manual checks covered light/dark contrast, equal horizontal insets, standard/narrow/short-height layouts, focus/caret usability, bottom lock, sequential and same-frame streaming, restore-window output, button/send re-locks, appended bottom-follow, touch momentum, composer reachability, and final-output clearance. Exact touch proof is `500→650→650px` in both narrow themes with `0px` overlap.

The SP2K embedded browser hydrated and was inspected against the live fixed DOM. Exact responsive measurements and evidence were captured from the same live three-process stack in system Chromium at explicit viewport sizes.

## Changelog

Chat output stays visible above the growing composer without jumping readers, including during streaming, explicit bottom re-locks, and touch momentum after the finger lifts.

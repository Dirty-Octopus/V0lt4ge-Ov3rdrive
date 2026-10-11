# Audio transport and source assets

The supplied WAV originals remain untouched under `audioAssets/`. The browser
loads 20 deployment FLAC files from `public/audio/` (18,571,758 bytes total,
approximately 17.7 MiB). Some supplied floating-point WAVs contain peaks above
0 dBFS: the loudest music peak is about 1.1408. `scripts/prepare-audio.py` applies
the same 0.85 gain (about −1.41 dB) to every clip before converting to 16-bit PCM
with triangular dither. This shared headroom prevents new hard clipping during
integer conversion and preserves the relative levels between all assets.
FLAC then compresses the PCM losslessly. This is not a bit-perfect copy of the
floating-point source; it preserves the original sample rate, channel count and
exact frame count. There is no trimming, per-track normalization, time stretching
or encoder padding.

Regenerate with Python 3, `ffmpeg` and `ffprobe` available:

```sh
python3 scripts/prepare-audio.py
```

The script fails if any output frame count/sample rate/channel count changes,
if the five phase loop lengths differ, or if a source needs more shared headroom.
The generated manifest contains source paths and peaks, the shared gain, exact
frame counts, durations, sizes and SHA-256 hashes.

## Exact source timing

All source files are stereo at 44,100 Hz.

| Material                |  Frames |    Duration |
| ----------------------- | ------: | ----------: |
| Menu fill               |  26,460 |  0.600000 s |
| Menu loop               | 846,720 | 19.200000 s |
| Game start              |  58,800 |  1.333333 s |
| Each of phases 1–5      | 940,800 | 21.333333 s |
| Ultimate charge         |  90,037 |  2.041655 s |
| Ultimate initial burst  |  24,806 |  0.562494 s |
| Ultimate main explosion | 164,456 |  3.729161 s |
| Complete ultimate audio | 279,299 |  6.333311 s |

## Scheduling and gameplay synchronization

`GameAudio` in `src/audio.js` preloads and decodes every file before gameplay.
Call `init(onProgress)` early; its callback receives `(fraction, assetName)`.
Network and decoding failures reject and can be retried; successfully decoded
buffers are retained. Call `unlock()` directly in the first user gesture. It
resumes both audio contexts synchronously before its first `await`, preserving
the gesture needed by browser autoplay policies.

- `playMenu()` schedules the fill and repeating menu buffer together, touching
  at the exact decoded-buffer boundary. Repeat calls do not layer new loops.
- `startGame()` fades menu music for 0.35 s. Game start is scheduled with 35 ms
  of lookahead and plays once; all five phase loops begin at its exact end.
  Its return value is `{ startedAt, phaseAt, introDuration }`.
- `setPhase(1..5)` uses a 0.65 s constant-sum linear crossfade. All five phase
  sources already share the same start time and loop duration; changing phase
  never restarts a source and cannot shift musical position. Linear fades
  avoid the gain bump equal-power fades would add to correlated shared music.
- `playUltimate()` schedules charge, initial burst and explosion in one call
  using exact decoded durations. There is no crossfade, delay or timer between
  those clips. The returned `{ start, startAt, burstAt, explosionAt, audioEnd,
end, endAt, chargeDuration, burstDuration, explosionDuration,
recoveryDuration }` uses absolute seconds on `audio.now`. `audioEnd` is the
  exact end of the last sound; `end` and `endAt` additionally include 0.65 s of
  visual/invulnerability recovery. Trigger visual stages from these timestamps.
- `playSfx('attack'|'killed'|'damage'|'click'|'change'|'achievement')` plays the
  provided sounds. Attack and kill variants are randomized without consecutive
  repeats. Modest voice limits prevent long overlapping tails from accumulating.
- `pause()` suspends the game audio clock, preserving loops and already-scheduled
  ultimate sounds. `resume()` continues from the same sample position. UI sounds
  run on a second lightweight context so pause-menu controls still make sound.
  Resume the game clock before returning to the main menu.
- `setVolumes({menuMusic,gameMusic,sfx})` smoothly changes three independent
  controls. Defaults are menu music 0.70, game music 0.50 and effects/UI 0.80.
  Menu fill/loop use the menu music bus; game start and all five phase loops use
  the game music bus. The menu's 0.35 s fade keeps its own volume while the game
  intro starts at the game volume. Partial updates leave other controls untouched,
  and volume changes never restart sources. All effects, including UI sounds,
  use the SFX slider. The old shared `music` parameter is no longer supported;
  preference migration belongs to the UI. `debugState.volumes` has the same
  `{menuMusic,gameMusic,sfx}` fields.
- `stopGame()` fades gameplay music and active non-UI effects out. `dispose()`
  stops everything and closes the contexts.
- `debugState` exposes read-only transport timing snapshots for verification.

No JavaScript timer, render frame or `ended` callback schedules the next music
or ultimate segment. Sources loop in Web Audio itself. Decoding may resample to
the audio device's sample rate; decoded durations are validated and every phase
must still have the same decoded length.

## Verification boundaries

`node --test tests/audio.test.js` checks scheduling with an injected audio clock:
exact menu/ultimate boundaries, phase alignment after loop wraps and interrupted
crossfades, UI audio while paused, retry after an asset request fails, independent
menu/game defaults and routing during the exit fade, and restoring saved volumes
before initialization.
Source/output sample counts are independently verified with `ffprobe` during
asset preparation.

On 2026-10-12, an isolated Playwright session in installed Google Chrome decoded
all 20 FLAC files at a 48 kHz device rate. Every phase decoded to exactly the same
21.333333333333332 s length. The menu transport ran, all phase sources shared one
start timestamp, a completed phase-three crossfade produced gains
`[0, 0, 1, 0, 0]`, and the ultimate used the actual resampled buffer durations.
Pausing left the main clock unchanged while the UI context remained running.
This automated, muted-browser check verifies decoding and scheduling; it is not
a listening test. Safari/iOS and physical-device listening remain separate QA.

`npx playwright test tests/audio-browser.spec.js --workers=1` also passes three
live-app regressions: a gesture during loading starts menu audio after loading,
a failed asset request retries successfully from the visible control, and paused
settings keep UI audio alive before returning to the menu and starting only one
game transport during concurrent restart requests.

The original source loop seams were inspected numerically. Their boundary steps
are below the nearby 99th-percentile adjacent-sample step: menu 9%, phases 1–5
20–30%. This does not suggest an exceptional loop discontinuity. Menu fill to menu
has a step of only 0.000203, and ultimate charge to initial burst has a 0.00433
step. Initial burst to main explosion has a stronger 0.719 step (1.73 times the
nearby 99th percentile), which may be the authored explosion transient. That
transition remains unchanged; numerical inspection cannot replace listening to
judge the intended impact.

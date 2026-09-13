# ARB — hand-tracked block building

Webcam + MediaPipe hand tracking + three.js, in a plain browser. No install, no
headset, no server-side anything: the model runs on your GPU in the page.

## Run

```bash
python serve.py 8123
```

Then open http://localhost:8123 and click **Enable camera**.
Must be served over http:// — `getUserMedia()` is blocked on `file://`.

## Layout

| file | role |
| --- | --- |
| `src/landmarks.js` | raw landmark math — distances, extensions, angles. No gesture names. |
| `src/gestures.js` | pose classifier + the `TUNING` thresholds, all in one place |
| `src/filters.js` | 1-Euro filter — smooth at rest, low-lag in motion |
| `src/hand-tracking.js` | camera + MediaPipe, emits one frame object per rAF |
| `src/overlay2d.js` | debug layer: 21 dots, skeleton, live pinch distance |
| `src/viewport.js` | shared `object-fit: cover` mapping so every layer lines up |
| `src/scene.js` | three.js layer + the `Block` mesh; maps landmarks -> world |
| `src/builder.js` | what the poses build: draw, grab-move, wipe, grid snap |
| `src/levels.js` | level specs, the checker, Shape Rush and daily-challenge draws |
| `src/session.js` | a Play run: ladder, daily or rush — clock, scoring, verdicts |
| `src/progress.js` | stars, best scores and daily results, saved on the device |
| `src/sound.js` | synthesized sound effects (Web Audio, no files) |
| `src/main.js` | wiring + HUD |
| `vendor/`, `models/` | vendored tasks-vision, three.js, hand_landmarker model (fully offline) |

## Poses

One classifier, one pose per hand per frame — `open`, `pinch`, `fist`, or the
transitional `none`. They are mutually exclusive on purpose: two poses firing at
once would try to draw a block and grab the scene simultaneously.

| gesture | does |
| --- | --- |
| two pinches on empty space, pull apart | draws a new block between the fingertips |
| two pinches **on an existing block** | reshapes that block instead |
| **one fist** on a block | picks up that block alone — it follows your hand |
| **one pinch** on a block | turns it: up/down tilts, left/right spins, a circle steers |
| open that hand | puts it down |
| ...at the **edge** of the frame | throws it away instead |
| two fists | grabs everything — move it, steer it like a wheel, spread to zoom |
| open the hands | everything locks where it is |
| two fists **touching** | arms a wipe — blocks turn **red** |
| then open | deletes everything |
| separate the fists instead | disarms, back to normal |

### Fist vs pinch

This one took three attempts and is worth reading before touching it.

Measured on a real hand:

| | curlMax | gap2d |
| --- | --- | --- |
| pinch | 0.479 | 0.146 |
| fist | 0.560 | 0.575 |

**Finger curl does not separate them at all** — the fist is fractionally the
*less* curled of the two. A pinch here is geometrically a fist with the thumb
moved onto the index tip, so the only thing that differs is where the thumb is.

The first attempt thresholded the raw thumb-to-index gap, which works only if
the thumb is stuck right out of the hand — a sideways thumbs-up, not a fist
anyone makes. In a natural fist the index tip folds into the palm and the thumb
comes to rest beside it, so the gap is as small as a pinch.

What works is asking *where along the index finger* the thumb sits:

```
tipRatio = distance(thumb tip, index tip) / distance(thumb tip, index PIP)
```

Pinch puts the thumb on the tip (ratio well under 1); a fist puts it across the
middle knuckle (ratio around 1 or above). Both distances live in the same small
patch of the image, so foreshortening scales them together and largely cancels.

Because that argument could still be wrong for a given hand, the signal is not
hard-coded. `TUNING.discriminator` names which metric to threshold, and:

```js
await ARB.calibrateFist()    // hold a pinch, then your natural fist
```

samples six candidates (`tipRatio`, `tipRatio3d`, `thumbToPalm`,
`thumbToPalm3d`, and both raw gaps), scores each by how cleanly it splits your
two poses, applies the winner, and prints a line to paste back into
`src/gestures.js`. A margin above ~0.3 means the two poses do not overlap on
that signal at all; a margin at or below 0 means no threshold on it can work.

The HUD shows the live value of whichever signal is selected, with its two
thresholds, so a misfire can be read straight off the screen.

## Zoom, and why the wipe had to shrink

Two fists now do two things at once: their midpoint translates the scene and the
distance between them scales it, about that midpoint. A grab that started with two fists carries on, translating only, if one opens.
The transform is re-baselined whenever the number of fists changes, so bringing
up a second hand does not snap the scene.

That put zoom and delete on the same gesture, which forced two changes to the
wipe:

- `wipe.gap` tightened from 0.20, since every shrink passes through "fists
  fairly close" and a delete can only be the extreme end of the range. 0.09 was
  then measurably too strict in use — fists held side by side never reached it —
  so it settled at **0.13**, which arms from touching up to about a fist's width
  apart while leaving 0.15 and wider as ordinary zoom.
- Arming became **reversible**. Pull the fists apart past `wipe.disarm` (0.20)
  and the red clears. A one-way arm would have turned every zoom-in into a scene
  deleted the moment you opened your hands. `disarm` has to move in step with
  `gap`: the span between them is the hysteresis, and narrowing it makes the red
  state flicker on and off at the boundary.

Scale is **exponential in how much further apart the fists are** than when the
zoom started — a difference, not a ratio.

The ratio (`span / baselineSpan`) is the obvious choice and it is a trap: it
divides by the starting separation. If the second fist happens to be recognized
while your hands are near each other, that divisor is tiny and every later
movement is multiplied out of all proportion. Measured, before the fix: a
baseline taken with the fists touching followed by an ordinary spread hit the 5x
ceiling exactly, and the same thing in reverse pinned the scene at the 0.2x
floor — the "everything suddenly went really small" glitch.

A difference has no divisor. A baseline that is off by 1 world unit costs 15% of
scale instead of a multiple, and the gesture behaves identically wherever it
starts: spreading your hands a given distance always scales by the same factor.
`zoom.doublePerUnits` sets that factor; `zoom.min`/`max` are now a genuine
safety net rather than the normal operating point.

Three further guards, each for a specific way the measured span can lie:

- **`grab.settleFrames`** — for the frames just after the number of fists
  changes, the transform is re-baselined every frame, pinning it to identity.
  Bringing up a second fist moves the anchor from one hand to the midpoint of
  both, and a hand still on its way into position kept dragging that midpoint,
  so the scene crept toward the newly closed hand. The cost is that motion in
  that window is ignored — deliberately, since that window is exactly when a
  hand is not yet where you mean it to be.
- **A stale hand freezes the transform.** A hand held through a tracking dropout
  has frozen coordinates; moving the scene from them would use a position that
  is no longer true. The grab survives the dropout, only the motion pauses.
- **`zoom.maxStepPerFrame`** eases the scale toward its target. The clamps bound
  where it can end up; this bounds how fast it gets there, so nothing that jolts
  the span in a single frame arrives as a jump.

## Reshaping an existing block

Two pinches landing on a block reshape it rather than drawing a new one. You can
grab **any** two points on it, not just corners: the builder records where each
pinch landed as a fraction of the block's own width and height, then solves for
the rect that keeps those two spots under those two fingertips. That is what
stops the block jumping to meet your fingers the moment you touch it.

Two guards make the algebra safe:

- If both fingers sit at nearly the same fraction along an axis
  (`box.minAxisSpread`), they say nothing about that axis's length — the size is
  a division by ~zero. That axis is translated at its current size instead.
- `box.grabMargin` widens each block's catch area, because no hand tracker is
  steady enough to land inside an exact edge.

The cost of the rule is that you cannot draw a new block on top of an existing
one. Reshaping the thing under your fingers is the far commoner intent, and the
alternative — a third pose as a modifier — is worse.

## One hand, one block

A hand that lands on a block picks up **that block, alone** — the whole scene
is the two-fist grab. The pose it lands with says what for:

| that hand | does |
| --- | --- |
| fist | the block follows your hand |
| pinch | the block turns |
| open | puts it down |
| open, at the edge of the frame | throws it away |

The same hand can switch between the two mid-hold. One fist on empty space
does nothing.

Carrying keeps the exact spot you grabbed under your palm. `hold.moveDeadZone`
has to be crossed first and `hold.slackDecay` then takes that slop back over a
few frames, so the block neither snaps nor trails your hand.

### Handing over

Only the hand that picked the block up steers it, with two exceptions. A second
pinch turns the hold into a two-pinch resize. A second fist beside a carrying
fist turns it into the scene grab: both hands rarely close on the same frame, so
the first fist often lands on a block on its way to grabbing everything, and the
move dead zone keeps that block still in the meantime.

### Surviving the transition

Closing a pinch into a fist passes through a shape that is neither, which
`gestures.js` reports as `POSE.NONE`. A hold rides that out, keeping the block
but sitting still. The two poses are tracked at different landmarks (pinch at
the fingertips, fist at the palm centre), so every switch re-baselines
(`_rebase`) and the block does not jump.

### Turning

A pinch turns the block about a **world** axis, chosen by the hand's first
clear motion and locked until the pinch lets go:

| motion | axis | looks like |
| --- | --- | --- |
| straight up/down | x | tilts toward or away from you |
| straight left/right | y | spins like a turntable |
| a circle | z | steers like a wheel |

It locks because a circle is made of up, down, left and right; reading all
three at once would wobble every steer on the other two axes. Nothing turns
until the hand has travelled `hold.turnLock`, which doubles as the dead zone
that lets a single pinch become half of a two-pinch resize.

A motion counts as a circle when its direction of travel has swung past
`hold.curveRad` by then, read over short `turnSegment`s so jitter cannot fake a
curve. Once steering, that same swing *is* the turn: every degree your direction
of travel swings after the lock turns the block a degree, whatever the size of
the circle. The swing spent reaching the lock is not applied, or the block would
jump — so one full circle lands at roughly 280°. Tilt and spin are
`tiltPerUnit` radians per world unit of travel from where the axis locked.

World axes rather than the block's own, so "up tilts it away" stays true however
the block is already turned (`Block.turnWorld`).

### Tilting is freestyle only

Levels, challenges and grid snap assume blocks face the camera: the checker and
Copy read `rotation.z`, Balance rides blocks on a beam in the plane, and snap
rounds a 2D outline. So `Builder`'s `tilt` option is on only in freestyle and
the tutorial; everywhere else a pinch only steers.

Hit-testing and resize were generalized so a tilted block still behaves.
`contains` asks whether the line of sight through a point passes through the
block's box (a slab test), and `toLocal`/`setLocalRect` use the full
orientation; for a block facing the camera both reduce to the old 2D maths. Snap
leaves a tilted block's orientation alone.

### Throwing one away

Carry a block into `hold.edgeMargin` (7%) of the frame edge and it turns
**red**; open your hand there and it is gone. Carry it back inside and the red
clears. Unlike the two-fist wipe this needs no arm/disarm hysteresis, because
the state is a direct function of where the block is, and undoing it is simply
moving it back.

Two rules keep an irreversible action off a hair trigger:

- **Only a deliberate release deletes.** The hand has to *open*. A hand the
  tracker merely lost does not count — dropouts are constant (see `graceMs`),
  and one at the edge of the frame would otherwise silently eat the block. The
  price is that flinging a block off-screen parks it at the edge rather than
  deleting it, since your hand leaves the frame before it can open.
- **The margin is not somewhere you land by accident.** At 7% the block's
  *centre* has to be carried properly into it, well past anywhere you would
  leave one on purpose. A block parked 12% in stays green.

That the block is red the whole time is the only reason a destructive action can
hang off simply opening your hand — the same bargain the two-fist wipe makes.

## Reliability

Three things fought fast movement, and the first two are fixed.

**Lag.** The pinch cursor used a fixed exponential average, which has to pick
one compromise between jitter at rest and lag in motion — that is the "I have to
move slowly" feeling. `filters.js` replaces it with a 1-Euro filter, which sets
its cutoff per frame from the hand's own speed. Measured against a simulated
reach at 60fps, worst tracking error in screen pixels:

| | relaxed reach (400ms) | fast snap (150ms) | jitter at rest |
| --- | --- | --- | --- |
| old fixed EMA | 32.6 px | 79.0 px | 1.5 px |
| 1-Euro (shipped) | **12.6 px** | **18.2 px** | **1.0 px** |

Note `beta: 30`, far above the values in the 1-Euro paper. The paper filters
screen pixels, where a moving hand clocks hundreds of units per second; these
are normalized 0..1 frame coords where the same hand clocks 1-3, and beta
multiplies that speed. At the paper's beta this filter was *three times laggier*
than the average it replaced. The constants come from a grid sweep, not taste.

**Dropouts.** MediaPipe loses a hand for a frame or two constantly — motion
blur, a hand crossing your face, a dim room. Every one of those used to end the
gesture: the block being drawn committed itself mid-pull, a held grab let go.
A pose now survives `TUNING.graceMs` (200ms) of the hand being missing, and
`minHandPresenceConfidence` / `minTrackingConfidence` dropped from 0.5 to 0.3 so
the tracker gives up on an already-found hand far less eagerly. Detection
confidence stays at 0.5 — that one decides a hand *exists*, and loosening it
invents hands.

**Two fists touching.** Hands held close together is one of the tracker's worst
cases, so the frame where the fists finally meet is the frame most likely to
drop one of them. Wipe arming therefore never resets its progress when a hand
goes missing — it only stops advancing — and the HUD reports which of the two
preconditions is still unmet (`separate fists first` / `bring fists together`),
because a gesture with two conditions otherwise fails completely silently.

**Hands in front of your face.** Not fixed, and not really fixable here: the
landmark model itself degrades when a hand overlaps a face, because skin-toned
background is exactly its hard case. Lower confidences help at the margin. The
reliable workaround is to keep hands clear of your face, or raise the contrast
between them (more light on the hands than the background).

## Drawing a block

Pinch with **both** hands, close together — a ghost block spawns between your
fingertips. Pull your hands apart and it grows, with each pinch welded to its
own corner of the block's front face (cross your hands and the corners swap).
Let either hand go and the block is committed.

Sizing thresholds live in `TUNING.box`. Watch the units: `spawnGap` is a
normalized image distance (0..1 across the camera frame), while `minSize` /
`minCommit` are **world** units on a build plane that is ~8.3 units tall.

Depth is not read from the hand. Fingertip z is far too noisy to drive a
dimension you can see, so a block's depth is derived from its face
(`depthRatio`) and its front face is pinned to the z = 0 plane — which is what
keeps the corners glued to the fingertips at any hand distance. Grabbed blocks
translate in that plane only, for the same reason.

## Tuning

All thresholds live in `TUNING` at the top of `src/gestures.js`, live-editable
from the console while the app runs:

```js
await ARB.calibrateFist()        // fist not recognized? measure and auto-fix
ARB.tuning.filter.beta = 45      // snap even harder to fast motion
ARB.tuning.graceMs = 300         // ride out longer tracking dropouts
ARB.tuning.wipe.armFrom = 0.20   // if the wipe never arms, ease the spread
ARB.tuning.hold.moveDeadZone = 0  // strictly 1:1 drag, no slop before it moves
ARB.tuning.hold.edgeMargin = 0.12 // a wider band at the edge to delete into
await ARB.calibrate(5)           // pinch: sample your own hand
```

`TUNING.wipe` distances are normalized over the **full** camera frame, which is
wider than the cropped region you see on screen — hands that look well apart
score lower than you would guess. `armFrom` started at 0.35, which two raised
hands barely reach, and that alone stopped the wipe from ever arming.

Pinch uses two signals because neither is good at both jobs:

| signal | pinched | open | good for |
| --- | --- | --- | --- |
| 2d image gap | 0.124 | 1.134 | **entry** — bottoms out on contact, 9x margin |
| 3d world gap | 0.367 | 1.210 | **release** — immune to foreshortening |

Entry is 2d only: the 3d gap floors near 0.37 even when squeezing hard, so it
can't tell a pinch from a near-pinch. Release is either signal, whichever fires
first — tilting the hand at the camera foreshortens the 2d gap to ~0.42 with the
fingers plainly apart, and 3d is what catches that.

Re-run `ARB.calibrate()` on your own hand and camera before trusting these.

## Mirroring

The three.js canvas is the one layer that is *not* CSS-mirrored: a negative
scale reverses face winding and breaks lighting and culling, so `scene.js`
mirrors x inside the projection instead. The un-mirroring rule in `style.css`
must out-specify `#stage > canvas` (hence `#stage > canvas#three`) — when it did
not, the canvas stayed CSS-mirrored, the math flip double-flipped it, and blocks
tracked left when the hands went right.

Note for testing this: reading pixels back out of the WebGL buffer will *not*
catch that class of bug, because the buffer is correct before the browser
composites the CSS transform on top. Check the composited position — project to
canvas pixels, then apply the element's computed transform matrix. The 2D
overlay and the 3D layer currently agree to 0.0000 px across aspect ratios.

## Play menu

One screen, three tabs, every card built the same way (art, name, blurb, best):

| tab | what's in it |
| --- | --- |
| Levels | One player (level select), Two players, Daily challenge |
| Challenges | Shape rush, Memory, Copy the shape, Balance scale, Copycat, Pop Rush |
| Arcade | Blockfall, Brick Breaker, Shape Invaders, Air Pong, Glow Worm |

The list lives in `PLAY_ITEMS` in `src/menu.js`; arcade-engine games are pulled
from `arcade/catalog.js` by their `section` (`retro` → Arcade, `challenge` →
Challenges). Leaving a run returns to the tab it was started from. Esc steps
back one screen.

## Arcade

Retro games with their rules rebuilt around the gestures above, in `src/arcade/`.
Every game reuses the app's own poses and the shape picker's finger count, so
nothing new has to be learned or tuned.

| game | after | hands |
| --- | --- | --- |
| Blockfall | Tetris | pinch anywhere grabs the piece, move to carry, pull down to drop, flick down to slam; fist rotates (left of the well turns left) |
| Brick Breaker | Breakout | palm steers the paddle; two hands stretch it between them; pinch launches; fist makes it sticky |
| Shape Invaders | Space Invaders | 1/2/3 fingers pick square/circle/triangle ammo and auto-fire; only the matching shape hits; fist raises a shield |
| Air Pong | Pong | palm height moves the paddle; pinch just before contact smashes; 1P vs cpu or 2P split screen |
| Glow Worm | Snake | the worm chases your index fingertip at a limited turn rate; pinch boosts |
| Copycat | Simon | repeat a growing sequence of pinch / fist / open / peace |
| Pop Rush | Whack-a-Mole | 45s: pinch bubbles, fist crates, pinch gold for time, avoid red bombs |

| file | role |
| --- | --- |
| `arcade/index.js` | the run: how-to card, countdown, auto-pause when hands leave, game over, best scores |
| `arcade/input.js` | `gestures.hands` → world-space palm/pinch/tip plus `justPinch`/`justFist` edges |
| `arcade/kit.js` | shared-material three.js shapes, particles, cursors on the build plane |
| `arcade/catalog.js` | names, controls, menu art, best scores (no three.js, so the menu can import it) |
| `arcade/games/*.js` | one file per game: `(ctx) => { update, idle, cursors, stats }` |

Pinch starts a game and replays it, so nobody has to reach for the mouse. P
pauses; a game also pauses itself when no hand has been seen for 0.9s and
resumes (after a short countdown) once one is back.

## Keys

- `d` — toggle the 2D landmark overlay (shows the classified pose per hand)
- `u` — undo the last block
- `c` — clear all blocks
- `g` — grid snap on/off (also in Settings; off by default)
- `m` — sound on/off (also in Settings)

## Play modes

- **One player** — ten levels at one difficulty. Each solve earns 1–3 stars:
  1 for building it, 2 at or under par, 3 in 60% of par. Best score, best time
  and stars are saved per level and shown on the level select.
- **Two players** — split screen race over a random easy-to-hard mix.
- **Shape rush** — one clock starting at 45s, endless one- and two-part
  targets. Each solve adds 60% of that level's par (clock caps at 120s). Best
  score is saved.
- **Daily challenge** — five levels (2 easy, 2 medium, 1 hard) drawn from a
  seed of the local date, so everyone gets the same set that day. The summary
  has a "copy result" button with a plain-text star grid.
- **Memory** — eight random levels, easy to hard. The target is shown for
  3s + 1.5s per part, then hidden; anything built while it was up is cleared.
  Hints only say how many shapes you have placed. A miss shows the answer.
- **Copy the shape** — eight rounds of outlines on the plane (one, then two,
  then three with 45° tilts). Fill each with a block of the same kind, size,
  spot and angle; an outline turns green when it is matched. Tolerances are in
  `COPY` (`src/modes/copy.js`).
- **Balance scale** — six rounds of a seesaw with fixed weights. A shape's
  weight is its face area, its pull is weight × distance from the pivot, and
  blocks resting on the beam (or stacked on ones that are) ride it as it tilts.
  Level within 10% and hold it. No physics engine — see `src/modes/balance.js`.

Memory, Copy and Balance save a best run score each. A level can bring its own
`setup`/`frame`/`check`/`teardown`/`art` hooks, which is how Copy and Balance
run on the same session code as the level ladders.

## Grid snap

Off by default. When on, a block settles onto a grid the moment you let go —
never while your hands are on it, because a block that steps under your
fingertips stops feeling attached to them. Size rounds to whole cells, angle to
15°, and the edges of its outline onto grid lines. The grid (`TUNING.snap.cells`
across the plane's height) is drawn only while snap is on and a block is in
hand. In two-player mode a snap that would nudge a block over the divider pushes
it back a cell instead.

## Build order

1. **done** — webcam + 21 landmarks drawn live
2. **done** — pinch detect with hysteresis + start/end events
3. **done** — three.js layer + translucent glowing blocks
4. **done** — two-handed pinch draws a block between the fingertips
5. **done** — fist grabs and moves everything; two fists wipe
6. **done** — two-fist zoom; two pinches reshape an existing block
7. **done** — one pinch drags a single block rather than all of them
8. **done** — fist turns the held block; carry it off the edge to delete
9. **done** — grid snap (optional)
10. **done** — sound, saved progress + stars, Shape rush, Daily challenge
11. **done** — one fist carries a block; one pinch tilts, spins or steers it

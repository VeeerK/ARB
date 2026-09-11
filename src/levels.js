/**
 * What Play mode asks you to build, and how it decides you have built it.
 *
 * A level is a SPEC, not a script: a list of parts (one shape each, with size
 * and angle constraints) plus relations between them ("the head sits on the
 * body, and is smaller"). Checking is therefore one function for every level,
 * which is the only way this stays trustworthy — a per-level checker would be
 * ten chances to get "is it built?" subtly wrong, and that answer decides who
 * wins a race.
 *
 * Every length here is a FRACTION OF THE BUILD PLANE'S HEIGHT, never world
 * units and never pixels. The plane is a fixed height in world units but its
 * width follows the window, and in two-player mode each player only has half
 * the width — so height is the one measure that means the same thing to both
 * players on any screen.
 *
 * Tolerances are deliberately loose. This is a webcam and a pair of hands: a
 * stack that reads as a stack to a person has to pass, or the game is about
 * fighting the tracker rather than about building.
 */

// ---- the shape of a level ------------------------------------------------
//
//  parts:      [{ name, kind, size?: [min,max], square?, angle? }]
//  relations:  [{ type, a, b, ... }]  — see RELATIONS below
//  points:     what a solve at par speed is worth
//  par:        seconds a competent player needs; the speed bonus is measured
//              against this, and the level times out at PAR_TIMEOUT x par.

const SMALL = [0.10, 0.26];
const MED   = [0.16, 0.40];
const BIG   = [0.30, 0.85];
const ANY   = [0.08, 0.95];

/** Slack, all as fractions of the plane height unless noted. */
export const TOLERANCE = {
  // How far two stacked shapes' centres may be apart horizontally, as a
  // fraction of the narrower one's width. Generous: a snowman leaning a little
  // is still a snowman.
  alignX: 0.55,
  // How far the touching faces may be apart, or overlapped, as a fraction of
  // the taller shape's height.
  contact: 0.45,
  // Degrees of slop on any angle constraint.
  angle: 18,
  // How square "square" has to be: the long edge over the short one.
  aspect: 1.5,
  // Frames of a continuously-correct board before it counts as solved. At
  // ~30fps this is about half a second — long enough that a shape passing
  // through the right place mid-drag cannot score, short enough that it does
  // not feel like the game is hesitating.
  holdFrames: 16,
};

/** How many times par before a level gives up on you. */
export const PAR_TIMEOUT = 2.5;

/**
 * Ten level themes, each in three difficulties. A theme is one idea ("a house")
 * and the difficulty decides how much of it you have to get right: easy asks
 * for the shapes, medium adds a relation, hard adds a third part or a
 * constraint you have to be deliberate about. Ten x three = thirty levels, and
 * the same checker reads every one of them.
 */

const P = (name, kind, size, extra = {}) => ({ name, kind, size, ...extra });
const on = (a, b) => ({ type: "on", a, b });
const beside = (a, b) => ({ type: "beside", a, b });
const smaller = (a, b, factor = 0.85) => ({ type: "smaller", a, b, factor });
const similar = (a, b, factor = 1.8) => ({ type: "similar", a, b, factor });

export const PACKS = [
  {
    id: "square", name: "Square",
    easy: {
      title: "One square", brief: "Draw a single square.",
      coach: "Pinch with both hands, bring them together, then pull apart.",
      points: 100, par: 20, parts: [P("square", "box", ANY)],
    },
    medium: {
      title: "Big square", brief: "One square, taller than a third of the screen.",
      coach: "Two pinches on a block you already made will resize it.",
      points: 160, par: 28, parts: [P("square", "box", BIG, { square: true })],
    },
    hard: {
      title: "Tilted square", brief: "A square turned about 45 degrees.",
      coach: "Pinch it with one hand, then close that hand into a fist to turn it.",
      points: 240, par: 40, parts: [P("square", "box", MED, { square: true, angle: 45 })],
    },
  },
  {
    id: "circle", name: "Circle",
    easy: {
      title: "One circle", brief: "Draw a single circle.",
      coach: "Hold up 2 fingers and wait for the ring, then pinch and pull apart.",
      points: 100, par: 22, parts: [P("circle", "circle", ANY)],
    },
    medium: {
      title: "Big circle", brief: "One circle, taller than a third of the screen.",
      coach: "Draw it small, then resize it with two pinches.",
      points: 160, par: 30, parts: [P("circle", "circle", BIG)],
    },
    hard: {
      title: "Two moons", brief: "Two circles side by side, about the same size.",
      coach: "Build one, carry it aside, then build the second to match.",
      points: 250, par: 45,
      parts: [P("first circle", "circle", MED), P("second circle", "circle", MED)],
      relations: [beside("first circle", "second circle"), similar("first circle", "second circle", 1.4)],
    },
  },
  {
    id: "triangle", name: "Triangle",
    easy: {
      title: "One triangle", brief: "Draw a single triangle.",
      coach: "Three fingers picks the triangle.",
      points: 100, par: 22, parts: [P("triangle", "triangle", ANY)],
    },
    medium: {
      title: "Big triangle", brief: "One triangle, taller than a third of the screen.",
      coach: "Pull your pinches further apart to draw bigger.",
      points: 160, par: 30, parts: [P("triangle", "triangle", BIG)],
    },
    hard: {
      title: "Tilted triangle", brief: "One triangle, turned about 45 degrees.",
      coach: "Pinch it with one hand, then close that hand into a fist to turn it.",
      points: 240, par: 40, parts: [P("triangle", "triangle", MED, { angle: 45 })],
    },
  },
  {
    id: "pair", name: "Side by side",
    easy: {
      title: "A pair", brief: "Two squares, side by side.",
      coach: "Carry a block by pinching it with one hand.",
      points: 170, par: 32,
      parts: [P("first square", "box", MED), P("second square", "box", MED)],
      relations: [beside("first square", "second square")],
    },
    medium: {
      title: "Big and small", brief: "Two squares side by side: one big, one small.",
      coach: "Make the big one first — there is more room while the plane is empty.",
      points: 240, par: 44,
      parts: [P("big square", "box", BIG), P("small square", "box", SMALL)],
      relations: [beside("big square", "small square"), smaller("small square", "big square", 0.7)],
    },
    hard: {
      title: "Three in a row", brief: "Three squares in a row, each smaller than the last.",
      coach: "Big, medium, small — spread out so none of them touch.",
      points: 360, par: 70,
      parts: [P("big square", "box", BIG), P("middle square", "box", MED), P("small square", "box", SMALL)],
      relations: [
        beside("big square", "middle square"), beside("middle square", "small square"),
        beside("big square", "small square"),
        smaller("middle square", "big square", 0.8), smaller("small square", "middle square", 0.8),
      ],
    },
  },
  {
    id: "stack", name: "Stack",
    easy: {
      title: "Stack of two", brief: "Two squares, one resting on the other.",
      coach: "Line them up — the top one has to sit on the bottom one.",
      points: 210, par: 40,
      parts: [P("top square", "box", MED), P("bottom square", "box", MED)],
      relations: [on("top square", "bottom square")],
    },
    medium: {
      title: "Tapered stack", brief: "Two squares stacked, the top one smaller.",
      coach: "Build the base first, then shrink the block you put on it.",
      points: 290, par: 52,
      parts: [P("top square", "box", SMALL), P("bottom square", "box", MED)],
      relations: [on("top square", "bottom square"), smaller("top square", "bottom square", 0.8)],
    },
    hard: {
      title: "Three high", brief: "Three squares stacked, each smaller going up.",
      coach: "Widest at the bottom. Move the top one last.",
      points: 420, par: 82,
      parts: [P("top square", "box", SMALL), P("middle square", "box", MED), P("base square", "box", BIG)],
      relations: [
        on("top square", "middle square"), on("middle square", "base square"),
        smaller("top square", "middle square", 0.85), smaller("middle square", "base square", 0.85),
      ],
    },
  },
  {
    id: "snowman", name: "Snowman",
    easy: {
      title: "Two circles", brief: "Two circles, one resting on the other.",
      coach: "Body first, then the head on top.",
      points: 210, par: 40,
      parts: [P("head", "circle", MED), P("body", "circle", MED)],
      relations: [on("head", "body")],
    },
    medium: {
      title: "Snowman", brief: "Two circles stacked, the top one smaller.",
      coach: "Build the body first, then put the head on top.",
      points: 300, par: 55,
      parts: [P("head", "circle", SMALL), P("body", "circle", MED)],
      relations: [on("head", "body"), smaller("head", "body", 0.8)],
    },
    hard: {
      title: "Three-ball snowman", brief: "Three circles stacked, each smaller going up.",
      coach: "Base, belly, head. Keep the centres in a line.",
      points: 440, par: 88,
      parts: [P("head", "circle", SMALL), P("belly", "circle", MED), P("base", "circle", BIG)],
      relations: [
        on("head", "belly"), on("belly", "base"),
        smaller("head", "belly", 0.85), smaller("belly", "base", 0.85),
      ],
    },
  },
  {
    id: "house", name: "House",
    easy: {
      title: "Roof on walls", brief: "A square with a triangle on top.",
      coach: "Any sizes — it just has to sit on top.",
      points: 220, par: 42,
      parts: [P("roof", "triangle", MED), P("walls", "box", MED)],
      relations: [on("roof", "walls")],
    },
    medium: {
      title: "House", brief: "A square with a triangle roof about as wide as it.",
      coach: "The roof should be about as wide as the walls.",
      points: 320, par: 60,
      parts: [P("roof", "triangle", MED), P("walls", "box", MED)],
      relations: [on("roof", "walls"), similar("roof", "walls", 1.6)],
    },
    hard: {
      title: "House on a step", brief: "Roof, walls, and a wider base under both.",
      coach: "Three parts in one column — base widest, roof on top.",
      points: 460, par: 90,
      parts: [P("roof", "triangle", MED), P("walls", "box", MED), P("base", "box", BIG)],
      relations: [
        on("roof", "walls"), on("walls", "base"),
        similar("roof", "walls", 1.6), smaller("walls", "base", 0.9),
      ],
    },
  },
  {
    id: "traffic", name: "Traffic light",
    easy: {
      title: "Two lights", brief: "Two small circles in a vertical stack.",
      coach: "Small circles, one directly above the other.",
      points: 220, par: 42,
      parts: [P("top light", "circle", SMALL), P("bottom light", "circle", SMALL)],
      relations: [on("top light", "bottom light")],
    },
    medium: {
      title: "Traffic light", brief: "Three small circles in one vertical stack.",
      coach: "Same size, one above the other.",
      points: 360, par: 68,
      parts: [
        P("top light", "circle", SMALL), P("middle light", "circle", SMALL),
        P("bottom light", "circle", SMALL),
      ],
      relations: [on("top light", "middle light"), on("middle light", "bottom light")],
    },
    hard: {
      title: "Matched lights", brief: "Three small circles stacked, all the same size.",
      coach: "Match the widths — a light wider than its neighbours fails.",
      points: 480, par: 92,
      parts: [
        P("top light", "circle", SMALL), P("middle light", "circle", SMALL),
        P("bottom light", "circle", SMALL),
      ],
      relations: [
        on("top light", "middle light"), on("middle light", "bottom light"),
        similar("top light", "middle light", 1.35), similar("middle light", "bottom light", 1.35),
      ],
    },
  },
  {
    id: "tree", name: "Tree",
    easy: {
      title: "Sapling", brief: "A triangle on a small square trunk.",
      coach: "Trunk on the ground, crown on the trunk.",
      points: 250, par: 48,
      parts: [P("crown", "triangle", MED), P("trunk", "box", SMALL)],
      relations: [on("crown", "trunk")],
    },
    medium: {
      title: "Tree", brief: "Two triangles stacked on a small square trunk.",
      coach: "Crown, crown, trunk — smallest at the top.",
      points: 410, par: 80,
      parts: [
        P("top crown", "triangle", SMALL), P("lower crown", "triangle", MED),
        P("trunk", "box", SMALL),
      ],
      relations: [
        on("top crown", "lower crown"), on("lower crown", "trunk"),
        smaller("top crown", "lower crown", 0.85),
      ],
    },
    hard: {
      title: "Tall pine", brief: "Three triangles stacked on a small square trunk.",
      coach: "Four parts. Get the trunk down first, then drop crowns onto it.",
      points: 560, par: 105,
      parts: [
        P("top crown", "triangle", SMALL), P("middle crown", "triangle", SMALL),
        P("lower crown", "triangle", MED), P("trunk", "box", SMALL),
      ],
      relations: [
        on("top crown", "middle crown"), on("middle crown", "lower crown"),
        on("lower crown", "trunk"),
        smaller("top crown", "middle crown", 0.9), smaller("middle crown", "lower crown", 0.9),
      ],
    },
  },
  {
    id: "tower", name: "Tower",
    easy: {
      title: "Ball on a box", brief: "A circle resting on a square.",
      coach: "Two different shapes — switch with your finger count.",
      points: 260, par: 48,
      parts: [P("ball", "circle", MED), P("box", "box", MED)],
      relations: [on("ball", "box")],
    },
    medium: {
      title: "Three shapes", brief: "Triangle on circle on square, in one column.",
      coach: "One of each, stacked, smallest at the top.",
      points: 440, par: 82,
      parts: [P("cap", "triangle", SMALL), P("ball", "circle", MED), P("base", "box", MED)],
      relations: [on("cap", "ball"), on("ball", "base"), smaller("cap", "ball", 0.9)],
    },
    hard: {
      title: "Grand tower", brief: "Triangle, circle, square, square — four parts in one column.",
      coach: "The whole vocabulary in one build. Widest at the bottom.",
      points: 640, par: 120,
      parts: [
        P("cap", "triangle", SMALL), P("ball", "circle", SMALL),
        P("upper block", "box", MED), P("base block", "box", BIG),
      ],
      relations: [
        on("cap", "ball"), on("ball", "upper block"), on("upper block", "base block"),
        smaller("upper block", "base block", 0.85),
      ],
    },
  },
];

export const DIFFICULTIES = ["easy", "medium", "hard"];
export const DIFFICULTY_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };

/** One playable level: a pack's variant, stamped with where it came from. */
function build(pack, difficulty) {
  return {
    ...pack[difficulty],
    id: `${pack.id}-${difficulty}`,
    pack: pack.id,
    packName: pack.name,
    difficulty,
  };
}

/** Every level, flat — for tooling and for the console. */
export const ALL_LEVELS = PACKS.flatMap((p) => DIFFICULTIES.map((d) => build(p, d)));

/** The ten-level ladder for one difficulty, optionally starting part-way in. */
export function ladder(difficulty = "easy", from = 0) {
  const d = DIFFICULTIES.includes(difficulty) ? difficulty : "easy";
  return PACKS.slice(clampIndex(from)).map((p) => build(p, d));
}

/** A single level, by pack index and difficulty. */
export const levelAt = (index, difficulty = "easy") =>
  build(PACKS[clampIndex(index)], DIFFICULTIES.includes(difficulty) ? difficulty : "easy");

const clampIndex = (i) => Math.max(0, Math.min(i | 0, PACKS.length - 1));

/** The default one-player run: all ten, on easy. */
export const LEVELS = ladder("easy");

// How a two-player ladder is shaped: three tiers, always climbing, but the
// tier sizes vary run to run so a rematch is never the same levels in the same
// order.
const SHAPES = [[3, 3, 3], [3, 4, 3], [4, 3, 3], [3, 3, 4], [2, 4, 3], [3, 4, 2]];

const shuffle = (list, rng = Math.random) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * The two-player ladder: an assortment, drawn fresh every game.
 *
 * Easy first, then medium, then hard, so a round always climbs — but WHICH
 * themes appear, and how many sit in each tier, is random. Themes are drawn
 * without replacement, so nobody builds the same house twice in one game, and
 * each tier is played in pack order, which is roughly the order they get
 * fiddly in.
 */
export function mixedLadder() {
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
  const pool = shuffle(PACKS.map((_, i) => i));
  const out = [];
  let cut = 0;
  DIFFICULTIES.forEach((difficulty, tier) => {
    const take = pool.slice(cut, cut + shape[tier]).sort((a, b) => a - b);
    cut += shape[tier];
    for (const i of take) out.push(build(PACKS[i], difficulty));
  });
  return out;
}

// ---- shape rush ----------------------------------------------------------

/**
 * Shape Rush: one shared clock, an endless stream of small targets, and every
 * solve buys time back. Only levels of one or two parts are in the pool — the
 * point is pace, and a four-part tower is a slog, not a rush.
 *
 *   start       seconds on the clock when the run begins
 *   bonusOfPar  a solve adds this fraction of the level's par, so beating half
 *               par gains time and dawdling slowly bleeds it
 *   max         the clock never banks more than this
 */
export const RUSH = { start: 45, bonusOfPar: 0.6, max: 120 };

const RUSH_POOL = ALL_LEVELS.filter((l) => l.parts.length <= 2);

export const rushBonus = (level) => Math.round(level.par * RUSH.bonusOfPar);

/**
 * The next target. Easy for the first three, easy or medium up to the seventh,
 * then anything in the pool — and never the same theme twice in a row.
 */
export function rushLevel(n, prev = null, rng = Math.random) {
  const tiers = n < 3 ? ["easy"] : n < 7 ? ["easy", "medium"] : DIFFICULTIES;
  const pool = RUSH_POOL.filter((l) => tiers.includes(l.difficulty) && l.pack !== prev?.pack);
  return { ...pool[Math.floor(rng() * pool.length)] };
}

// ---- daily challenge -----------------------------------------------------

/** Today's date as YYYY-MM-DD, in the player's own time zone. */
export function todayKey(d = new Date()) {
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A repeatable random stream from a string: same seed, same numbers, on
 *  every machine. FNV-1a to hash, mulberry32 to generate. */
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How the five daily levels climb. */
const DAILY_TIERS = { easy: 2, medium: 2, hard: 1 };

/** Themes drawn without replacement, `counts[difficulty]` of each, climbing. */
function tieredDraw(counts, rng = Math.random) {
  const pool = shuffle(PACKS.map((_, i) => i), rng);
  const out = [];
  let cut = 0;
  for (const difficulty of DIFFICULTIES) {
    const n = counts[difficulty] ?? 0;
    const take = pool.slice(cut, cut + n).sort((a, b) => a - b);
    cut += n;
    for (const i of take) out.push(build(PACKS[i], difficulty));
  }
  return out;
}

/**
 * The daily challenge: five levels, the same for everyone on the same date,
 * because the draw is seeded by the date and nothing else. Themes are drawn
 * without replacement and climb easy to hard, like the two-player ladder.
 */
export function dailyLadder(date = todayKey()) {
  return tieredDraw(DAILY_TIERS, seeded(`air-blocks-daily-${date}`));
}

// ---- memory --------------------------------------------------------------

/**
 * Memory: the target is shown for a few seconds, then hidden, and you build it
 * from memory. More parts means more to remember, so the study time grows
 * with them.
 */
export const MEMORY = { tiers: { easy: 3, medium: 3, hard: 2 }, studyBase: 3, studyPerPart: 1.5 };

export const studySeconds = (level) =>
  Math.round(MEMORY.studyBase + MEMORY.studyPerPart * (level.parts?.length ?? 1));

/** A fresh run of eight: a random assortment, climbing, each flagged `memory`. */
export const memoryLadder = () => tieredDraw(MEMORY.tiers).map((lv) => ({ ...lv, memory: true }));

// ---- measuring a board ---------------------------------------------------

/**
 * One block, in the units the rules are written in: sizes and positions as
 * fractions of the plane height, angle in degrees folded into 0..180 (a square
 * turned 180 degrees is the same square, and no rule should be able to tell).
 */
function measure(block, planeH) {
  const s = block.mesh.scale, p = block.mesh.position;
  const deg = ((block.mesh.rotation.z * 180) / Math.PI) % 180;
  return {
    block,
    kind: block.kind,
    w: s.x / planeH,
    h: s.y / planeH,
    x: p.x / planeH,
    y: p.y / planeH,
    angle: deg < 0 ? deg + 180 : deg,
    span: Math.max(s.x, s.y) / planeH,
  };
}

// ---- the rules -----------------------------------------------------------
//
// Each returns null when satisfied, or a short phrase naming what is wrong.
// The phrase is what the player is shown, so it says what to DO, not what
// failed: "put the head on the body", never "relation `on` unsatisfied".

const RELATIONS = {
  /** `a` rests on top of `b`: overlapping horizontally, touching vertically. */
  on(a, b) {
    if (a.y <= b.y) return `put the ${a.name} above the ${b.name}`;
    const dx = Math.abs(a.x - b.x);
    if (dx > TOLERANCE.alignX * Math.min(a.w, b.w)) return `line the ${a.name} up over the ${b.name}`;
    // Distance between the two facing edges. Negative means they overlap,
    // which is fine — blocks are drawn by hand and a little overlap reads as
    // resting on. Only a real gap fails.
    const gap = (a.y - a.h / 2) - (b.y + b.h / 2);
    const slack = TOLERANCE.contact * Math.max(a.h, b.h);
    if (gap > slack) return `sit the ${a.name} down onto the ${b.name}`;
    if (gap < -slack) return `lift the ${a.name} off the ${b.name}`;
    return null;
  },

  /** Side by side, clear of each other, rather than stacked. */
  beside(a, b) {
    const dx = Math.abs(a.x - b.x);
    if (dx < ((a.w + b.w) / 2) * 0.6) return "move them apart, side by side";
    return null;
  },

  /** `a` is meaningfully smaller than `b`. */
  smaller(a, b, { factor = 0.85 } = {}) {
    if (a.span > b.span * factor) return `make the ${a.name} smaller than the ${b.name}`;
    return null;
  },

  /** Roughly the same width — a roof that fits its walls. */
  similar(a, b, { factor = 1.8 } = {}) {
    const r = Math.max(a.w / b.w, b.w / a.w);
    if (r > factor) return `make the ${a.name} about as wide as the ${b.name}`;
    return null;
  },
};

/** Part-level constraints: the shape itself, before anything relational. */
function checkPart(part, m) {
  if (part.size) {
    const [min, max] = part.size;
    if (m.span < min) return `make the ${part.name} bigger`;
    if (m.span > max) return `make the ${part.name} smaller`;
  }
  if (part.square) {
    const r = Math.max(m.w / m.h, m.h / m.w);
    if (r > TOLERANCE.aspect) return `make the ${part.name} square`;
  }
  if (part.angle != null) {
    // Angles wrap: 45 and 225 degrees are the same tilt on screen. Compare on
    // the circle rather than on the number line.
    const want = ((part.angle % 180) + 180) % 180;
    const d = Math.abs(m.angle - want);
    if (Math.min(d, 180 - d) > TOLERANCE.angle) return `turn the ${part.name} to about ${part.angle} degrees`;
  }
  return null;
}

/** Every way to assign n blocks to n parts. n is 1..3 here, so 6 at worst. */
function* permutations(items) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

/**
 * Is this board the level?
 *
 * @returns {{ok:boolean, hint:string, have:number, need:number}}
 *
 * Extra blocks fail on purpose: "build a snowman" means a snowman, not a
 * snowman in a pile of offcuts, and without that rule a player could brute
 * force a level by filling their half with shapes until two of them happened
 * to line up.
 */
export function checkLevel(level, blocks, planeH) {
  const parts = level.parts;
  const need = parts.length;
  const out = (ok, hint) => ({ ok, hint, have: blocks.length, need });

  if (blocks.length < need) {
    const missing = need - blocks.length;
    return out(false, blocks.length === 0
      ? (level.coach ?? level.brief)
      : `${missing} more shape${missing > 1 ? "s" : ""} to go`);
  }
  if (blocks.length > need) return out(false, "too many shapes — clear the extras");

  const measured = blocks.map((b) => measure(b, planeH));

  // Kinds first: it is the cheapest test and the clearest thing to say.
  const want = tally(parts.map((p) => p.kind));
  const got = tally(measured.map((m) => m.kind));
  for (const kind of new Set([...want.keys(), ...got.keys()])) {
    const w = want.get(kind) ?? 0, g = got.get(kind) ?? 0;
    if (g < w) return out(false, `you need ${w} ${plural(kind, w)}`);
    if (g > w) return out(false, `too many ${plural(kind, g)}`);
  }

  // The kinds line up, so some assignment might work. Report the failure from
  // the assignment that got furthest, which is the one a player would agree is
  // "the" mistake.
  let best = null;
  for (const order of permutations(measured)) {
    const named = {};
    let failure = null, passed = 0, usable = true;

    for (let i = 0; i < parts.length; i++) {
      if (order[i].kind !== parts[i].kind) { usable = false; break; }
      named[parts[i].name] = { ...order[i], name: parts[i].name };
      if (failure) continue;
      failure = checkPart(parts[i], order[i]);
      if (!failure) passed++;
    }
    if (!usable) continue;                 // kinds do not line up this way

    for (const rel of level.relations ?? []) {
      if (failure) break;
      const fn = RELATIONS[rel.type];
      failure = fn ? fn(named[rel.a], named[rel.b], rel) : null;
      if (!failure) passed++;
    }

    if (!failure) return out(true, "");
    if (!best || passed > best.passed) best = { passed, failure };
  }

  return out(false, best?.failure ?? "not quite");
}

const tally = (list) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
const NAMES = { box: "square", circle: "circle", triangle: "triangle" };
const plural = (kind, n) => `${NAMES[kind] ?? kind}${n === 1 ? "" : "s"}`;

// ---- scoring -------------------------------------------------------------

/** Fastest and slowest the speed multiplier can get. */
export const SPEED = { min: 0.4, max: 2.0 };

/**
 * Points for a solve. Harder levels are worth more (that is `level.points`),
 * and speed multiplies it: solving in half of par doubles it, dawdling floors
 * at 40%. A multiplier rather than a flat bonus, so the ordering of the levels
 * is never overturned by a fast solve on an easy one.
 */
export function scoreFor(level, seconds) {
  const mult = clamp(level.par / Math.max(seconds, 0.1), SPEED.min, SPEED.max);
  return { points: Math.round(level.points * mult), mult: +mult.toFixed(2) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- the picture of the target ------------------------------------------

/**
 * A diagram of what to build, drawn from the same spec the checker reads — so
 * the picture cannot drift out of step with the rules the way a hand-drawn one
 * would. Laid out on a 120x100 stage: parts stack bottom-up along their `on`
 * relations, and anything not in that chain sits beside it on the baseline.
 */
export function levelArt(level) {
  const pick = (part) => {
    const max = part.size?.[1] ?? 0.5;
    return max <= 0.26 ? 22 : max <= 0.4 ? 34 : 52;
  };

  // name of the part underneath -> the part on top of it
  const under = new Map();
  for (const rel of level.relations ?? []) if (rel.type === "on") under.set(rel.b, rel.a);

  const byName = new Map(level.parts.map((p) => [p.name, p]));
  // The bottom of a stack is a part nothing sits on.
  const onTopOf = new Set([...under.values()]);
  const column = [];
  let cur = level.parts.find((p) => under.has(p.name) && !onTopOf.has(p.name));
  let guard = 0;
  while (cur && guard++ < 8) {
    column.push(cur);
    cur = byName.get(under.get(cur.name));
  }
  const loose = level.parts.filter((p) => !column.includes(p));

  let svg = "";
  let y = 88;                                 // baseline, drawing upward
  // A four-part tower is taller than the stage, so the whole column is scaled
  // to fit rather than clipped: the picture is about the arrangement, and a
  // roof cut off by the frame is not one.
  const colSizes = column.map(pick);
  const colFit = Math.min(1, 84 / Math.max(colSizes.reduce((n, s) => n + s, 0), 1));
  column.forEach((part, i) => {
    const s = colSizes[i] * colFit;
    svg += shapeSvg(part.kind, 60, y - s / 2, s, part.angle);
    y -= s;
  });
  // Anything not in the stack stands on the baseline beside it. Laid out by
  // actual width with a fixed gap, then centred and shrunk to fit — a fixed
  // step overlaps three parts as soon as one of them is a big square.
  if (loose.length) {
    const sizes = loose.map(pick);
    const GAP = 8;
    const stackW = column.length ? 56 : 0;
    const total = sizes.reduce((n, s) => n + s, 0) + GAP * (loose.length - 1) + stackW;
    const fit = Math.min(1, 112 / total);
    let x = 60 - (total * fit) / 2 + stackW * fit;
    loose.forEach((part, i) => {
      const s = sizes[i] * fit;
      svg += shapeSvg(part.kind, x + s / 2, 88 - s / 2, s, part.angle);
      x += s + GAP * fit;
    });
  }

  return `<svg viewBox="0 0 120 100" class="goal-svg" aria-hidden="true">${svg}</svg>`;
}

/** One outline on the 120x100 goal stage. `s` is the width; `h` defaults to it. */
export function shapeSvg(kind, cx, cy, s, angle, h = s) {
  const spin = angle ? ` transform="rotate(${angle} ${cx} ${cy})"` : "";
  const cls = ' class="goal-shape"';
  if (kind === "circle") return `<ellipse cx="${cx}" cy="${cy}" rx="${s / 2}" ry="${h / 2}"${cls}${spin} />`;
  if (kind === "triangle") {
    const pts = [[cx, cy - h / 2], [cx - s / 2, cy + h / 2], [cx + s / 2, cy + h / 2]]
      .map(([x, y]) => `${x},${y}`).join(" ");
    return `<polygon points="${pts}"${cls}${spin} />`;
  }
  return `<rect x="${cx - s / 2}" y="${cy - h / 2}" width="${s}" height="${h}" rx="2"${cls}${spin} />`;
}

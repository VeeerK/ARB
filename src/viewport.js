/**
 * The video element is displayed with `object-fit: cover`, so the visible frame
 * is a center-crop of the camera image. Every overlay (this step's 2D canvas,
 * the three.js canvas in step 3) has to use the same crop or the drawing will
 * drift away from the hand.
 *
 * `coverMapping` returns the transform from MediaPipe's normalized landmark
 * space (0..1 over the *full* camera frame) into CSS pixels of the stage.
 */
export function coverMapping(videoW, videoH, cssW, cssH) {
  if (!videoW || !videoH || !cssW || !cssH) {
    return { scale: 1, offsetX: 0, offsetY: 0, cssW, cssH };
  }
  const scale = Math.max(cssW / videoW, cssH / videoH);
  return {
    scale,
    offsetX: (cssW - videoW * scale) / 2,
    offsetY: (cssH - videoH * scale) / 2,
    cssW,
    cssH,
  };
}

/** Normalized landmark (0..1) -> CSS pixel coords inside the stage. */
export function toPixels(map, videoW, videoH, nx, ny) {
  return {
    x: nx * videoW * map.scale + map.offsetX,
    y: ny * videoH * map.scale + map.offsetY,
  };
}

/**
 * Size a canvas to its CSS box at the current devicePixelRatio and return the
 * context pre-scaled so all drawing can be done in CSS pixels.
 */
export function fitCanvas(canvas, ctx) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cssW: rect.width, cssH: rect.height };
}

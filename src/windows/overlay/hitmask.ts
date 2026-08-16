/**
 * Builds the alpha mask that Rust tests the cursor against.
 *
 * The mask is a 1-bit bitmap of the sprite's texture at roughly a quarter of
 * the display resolution. It is deliberately *not* rebuilt for every frame:
 * because the Rust side stores the mask together with its rectangle and
 * normalises the lookup by that rectangle, the same bitmap stays correct while
 * the pet moves, breathes or gets squashed. Only a new texture, a flip or a
 * new base size force a rebuild.
 */
import type { HitMaskPayload } from '../../shared/ipc';

/** Target edge length of one mask cell, in logical pixels. */
export const MASK_CELL = 4;

/**
 * Downscaling averages the alpha of the covered source pixels, so a cell that
 * is only partly covered lands well below 255. Being generous here means the
 * pet is easy to grab and the outline never feels sharp-edged.
 */
const ALPHA_THRESHOLD = 24;

export interface MaskSource {
  image: CanvasImageSource;
  /** Natural pixel size of `image`. */
  sourceWidth: number;
  sourceHeight: number;
}

export interface MaskOptions {
  /** Displayed size in logical px; drives the grid resolution. */
  displayWidth: number;
  displayHeight: number;
  flipX: boolean;
}

export interface HitMaskBitmap {
  cols: number;
  rows: number;
  bits: number[];
}

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function context(cols: number, rows: number): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== cols || scratch.height !== rows) {
    scratch.width = cols;
    scratch.height = rows;
    scratchCtx = null;
  }
  if (!scratchCtx) {
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable — cannot build the hit mask');
    scratchCtx = ctx;
  }
  return scratchCtx;
}

export function buildHitMask(source: MaskSource, options: MaskOptions): HitMaskBitmap {
  const cols = Math.max(1, Math.ceil(options.displayWidth / MASK_CELL));
  const rows = Math.max(1, Math.ceil(options.displayHeight / MASK_CELL));

  const ctx = context(cols, rows);
  ctx.clearRect(0, 0, cols, rows);
  ctx.save();
  if (options.flipX) {
    ctx.translate(cols, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source.image, 0, 0, source.sourceWidth, source.sourceHeight, 0, 0, cols, rows);
  ctx.restore();

  const { data } = ctx.getImageData(0, 0, cols, rows);
  const bits = new Array<number>(Math.ceil((cols * rows) / 8)).fill(0);
  for (let index = 0; index < cols * rows; index += 1) {
    const alpha = data[index * 4 + 3] ?? 0;
    if (alpha >= ALPHA_THRESHOLD) {
      // Non-null: the array was sized to cover every index.
      bits[index >> 3] = (bits[index >> 3] as number) | (1 << (index & 7));
    }
  }

  return { cols, rows, bits };
}

export const toPayload = (
  bitmap: HitMaskBitmap,
  bounds: { x: number; y: number; width: number; height: number },
): HitMaskPayload => ({
  x: bounds.x,
  y: bounds.y,
  width: bounds.width,
  height: bounds.height,
  cols: bitmap.cols,
  rows: bitmap.rows,
  bits: bitmap.bits,
});

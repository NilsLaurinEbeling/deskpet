/**
 * Typed wrappers around the Tauri commands and events of the overlay window.
 * Everything the frontend sends to Rust goes through here.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Geometry of the overlay, in logical pixels relative to its client area. */
export interface OverlayGeometry {
  label: string;
  scaleFactor: number;
  width: number;
  height: number;
  /** Bottom edge of the monitor's work area — the pet stands here. */
  groundY: number;
  monitor: string | null;
}

/**
 * Pushed by the Rust cursor poller ~30x per second. The overlay is
 * click-through most of the time and therefore sees no DOM pointer events,
 * so this is the only way for the pet to know where the cursor is.
 */
export interface CursorState {
  x: number;
  y: number;
  inside: boolean;
  overPet: boolean;
  interactive: boolean;
}

/** Downsampled 1-bit alpha mask of the pet, in window-local logical pixels. */
export interface HitMaskPayload {
  x: number;
  y: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** Row-major, LSB first. */
  bits: number[];
}

export interface HitMaskBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CURSOR_EVENT = 'deskpet://cursor';

export const overlayGeometry = (): Promise<OverlayGeometry> => invoke('overlay_geometry');

export const setHitMask = (mask: HitMaskPayload): Promise<void> =>
  invoke('set_hit_mask', { mask });

/** Cheap per-frame update: same bitmap, new rectangle. */
export const setHitMaskBounds = ({ x, y, width, height }: HitMaskBounds): Promise<void> =>
  invoke('set_hit_mask_bounds', { x, y, width, height });

export const clearHitMask = (): Promise<void> => invoke('clear_hit_mask');

/**
 * Keeps the overlay interactive while the pet is being dragged, so a fast
 * drag cannot slip out of the mask and drop the pointer stream.
 */
export const setHitGrab = (grabbed: boolean): Promise<void> =>
  invoke('set_hit_grab', { grabbed });

/** Mirrors `Settings.clickThrough`. */
export const setHitTestingEnabled = (enabled: boolean): Promise<void> =>
  invoke('set_hit_testing_enabled', { enabled });

export const onCursor = (handler: (state: CursorState) => void): Promise<UnlistenFn> =>
  listen<CursorState>(CURSOR_EVENT, (event) => handler(event.payload));

/** Commands must never fail silently — see CLAUDE.md §7. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

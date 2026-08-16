/**
 * Owns the PixiJS application, the render loop and every piece of state the
 * loop touches (CLAUDE.md §7). React only mounts and unmounts it and renders
 * whatever `onStatus` reports.
 */
import { Application, Texture } from 'pixi.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';

import {
  clearHitMask,
  describeError,
  onCursor,
  overlayGeometry,
  setHitGrab,
  setHitMask,
  setHitMaskBounds,
  type CursorState,
  type OverlayGeometry,
} from '../../shared/ipc';
import { buildHitMask, toPayload, type HitMaskBitmap } from './hitmask';
import { PetSprite } from './PetSprite';

/** Render rate. Battery life is a feature — see CLAUDE.md §7. */
const TARGET_FPS = 30;

/** Height of the placeholder pet in logical pixels. */
const PET_HEIGHT = 180;

/**
 * Don't bother Rust with rectangle changes smaller than this. One mask cell is
 * four logical pixels, so sub-pixel updates buy no accuracy at all — they just
 * cost an IPC round trip on every frame the pet breathes.
 */
const BOUNDS_EPSILON = 1;

const PLACEHOLDER_URL = '/pet-placeholder.png';

export interface StageStatus {
  geometry: OverlayGeometry | null;
  cursor: CursorState | null;
  fps: number;
  clicks: number;
  dragging: boolean;
  mask: { cols: number; rows: number; bytes: number } | null;
  error: string | null;
}

export type StatusListener = (status: StageStatus) => void;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class PetStage {
  private readonly app = new Application();
  private readonly onStatus: StatusListener;

  private pet: PetSprite | null = null;
  private maskSource: ImageBitmap | null = null;
  private geometry: OverlayGeometry | null = null;

  private maskBitmap: HitMaskBitmap | null = null;
  private maskKey = '';
  private maskBounds: Bounds | null = null;
  /** One in-flight mask call at a time; frames are cheap, IPC is not. */
  private maskBusy = false;

  private cursor: CursorState | null = null;
  private clicks = 0;
  private dragOffset: { x: number; y: number } | null = null;
  private error: string | null = null;
  private destroyed = false;

  private unlisten: UnlistenFn[] = [];
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private readonly boundPointerMove = (event: PointerEvent) => this.onPointerMove(event);
  private readonly boundPointerUp = () => this.endDrag();

  private constructor(onStatus: StatusListener) {
    this.onStatus = onStatus;
  }

  static async mount(host: HTMLElement, onStatus: StatusListener): Promise<PetStage> {
    const stage = new PetStage(onStatus);
    await stage.init(host);
    return stage;
  }

  private async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      // WebView2 has no WebGPU; pinning the renderer keeps dev and release
      // identical and avoids probing for a backend that will never be there.
      preference: 'webgl',
      backgroundAlpha: 0,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      powerPreference: 'low-power',
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    host.appendChild(this.app.canvas);
    this.app.ticker.maxFPS = TARGET_FPS;
    this.app.stage.eventMode = 'static';

    this.geometry = await overlayGeometry();

    // Load the bitmap ourselves: the same decoded image feeds both the texture
    // and the alpha mask, so the two can never disagree.
    const response = await fetch(PLACEHOLDER_URL);
    if (!response.ok) {
      throw new Error(`could not load ${PLACEHOLDER_URL}: HTTP ${response.status}`);
    }
    this.maskSource = await createImageBitmap(await response.blob());

    const pet = new PetSprite(Texture.from(this.maskSource));
    pet.setBaseHeight(PET_HEIGHT);
    pet.setPosition(this.geometry.width / 2, this.geometry.groundY);
    pet.view.on('pointerdown', (event) => this.beginDrag(event.global.x, event.global.y));
    this.app.stage.addChild(pet.view);
    this.pet = pet;

    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp);
    window.addEventListener('pointercancel', this.boundPointerUp);

    this.unlisten.push(
      await onCursor((cursor) => {
        this.cursor = cursor;
        this.publish();
      }),
    );

    const appWindow = getCurrentWindow();
    this.unlisten.push(await appWindow.onResized(() => void this.refreshGeometry()));
    this.unlisten.push(await appWindow.onScaleChanged(() => void this.refreshGeometry()));

    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
    // The status panel needs a heartbeat: most frames change nothing the
    // frontend would otherwise report.
    this.statusTimer = setInterval(() => this.publish(), 500);
    this.publish();
  }

  private tick(deltaSeconds: number): void {
    const pet = this.pet;
    if (!pet || this.destroyed) return;
    pet.update(deltaSeconds);
    this.syncMask(pet);
  }

  /**
   * Rebuilds the bitmap only when the sprite's identity changes; a pet that
   * merely moved or breathed just gets a new rectangle. Rust normalises the
   * lookup by that rectangle, so the bitmap stays valid.
   */
  private syncMask(pet: PetSprite): void {
    if (this.maskBusy || !this.maskSource) return;

    const bounds = pet.bounds();
    const key = `${pet.flipped ? 'l' : 'r'}:${Math.round(pet.baseWidth)}x${Math.round(pet.baseHeight)}`;

    if (key !== this.maskKey) {
      this.maskBitmap = buildHitMask(
        {
          image: this.maskSource,
          sourceWidth: this.maskSource.width,
          sourceHeight: this.maskSource.height,
        },
        {
          displayWidth: pet.baseWidth,
          displayHeight: pet.baseHeight,
          flipX: pet.flipped,
        },
      );
      this.maskKey = key;
      this.maskBounds = bounds;
      this.send(setHitMask(toPayload(this.maskBitmap, bounds)));
      this.publish();
      return;
    }

    if (this.maskBounds && !this.boundsChanged(this.maskBounds, bounds)) return;
    this.maskBounds = bounds;
    this.send(setHitMaskBounds(bounds));
  }

  private boundsChanged(previous: Bounds, next: Bounds): boolean {
    return (
      Math.abs(previous.x - next.x) >= BOUNDS_EPSILON ||
      Math.abs(previous.y - next.y) >= BOUNDS_EPSILON ||
      Math.abs(previous.width - next.width) >= BOUNDS_EPSILON ||
      Math.abs(previous.height - next.height) >= BOUNDS_EPSILON
    );
  }

  private send(call: Promise<void>): void {
    this.maskBusy = true;
    call
      .catch((cause: unknown) => this.fail(describeError(cause)))
      .finally(() => {
        this.maskBusy = false;
      });
  }

  private beginDrag(x: number, y: number): void {
    const pet = this.pet;
    if (!pet) return;
    this.clicks += 1;
    this.dragOffset = { x: pet.x - x, y: pet.y - y };
    pet.poke();
    pet.view.cursor = 'grabbing';
    // Hold the window interactive: a fast drag could otherwise outrun the mask
    // and lose the pointer stream mid-gesture.
    setHitGrab(true).catch((cause: unknown) => this.fail(describeError(cause)));
    this.publish();
  }

  private onPointerMove(event: PointerEvent): void {
    const pet = this.pet;
    const offset = this.dragOffset;
    const geometry = this.geometry;
    if (!pet || !offset || !geometry) return;
    const halfWidth = pet.baseWidth / 2;
    pet.setPosition(
      clamp(event.clientX + offset.x, halfWidth, geometry.width - halfWidth),
      clamp(event.clientY + offset.y, pet.baseHeight, geometry.height),
    );
  }

  private endDrag(): void {
    if (!this.dragOffset) return;
    this.dragOffset = null;
    if (this.pet) {
      this.pet.view.cursor = 'grab';
      this.pet.poke(0.6);
    }
    setHitGrab(false).catch((cause: unknown) => this.fail(describeError(cause)));
    this.publish();
  }

  private async refreshGeometry(): Promise<void> {
    try {
      const geometry = await overlayGeometry();
      this.geometry = geometry;
      this.app.renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
      if (this.pet) {
        this.pet.setPosition(
          clamp(this.pet.x, 0, geometry.width),
          Math.min(this.pet.y, geometry.groundY),
        );
      }
      // The window moved to a different DPI: the cached rectangle is stale.
      this.maskKey = '';
      this.publish();
    } catch (cause) {
      this.fail(describeError(cause));
    }
  }

  private fail(message: string): void {
    if (this.error === message) return;
    this.error = message;
    console.error('[deskpet]', message);
    this.publish();
  }

  private publish(): void {
    if (this.destroyed) return;
    this.onStatus({
      geometry: this.geometry,
      cursor: this.cursor,
      fps: Math.round(this.app.ticker.FPS),
      clicks: this.clicks,
      dragging: this.dragOffset !== null,
      mask: this.maskBitmap
        ? {
            cols: this.maskBitmap.cols,
            rows: this.maskBitmap.rows,
            bytes: this.maskBitmap.bits.length,
          }
        : null,
      error: this.error,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.statusTimer !== null) clearInterval(this.statusTimer);
    window.removeEventListener('pointermove', this.boundPointerMove);
    window.removeEventListener('pointerup', this.boundPointerUp);
    window.removeEventListener('pointercancel', this.boundPointerUp);
    for (const off of this.unlisten) off();
    this.unlisten = [];
    // Best effort: the window is going away anyway.
    void clearHitMask().catch(() => undefined);
    this.maskSource?.close();
    this.app.destroy(true, { children: true });
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

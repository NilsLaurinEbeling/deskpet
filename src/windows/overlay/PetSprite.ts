/**
 * The pet's visual: one sprite plus the transforms that make it look alive.
 * Phase 1 only needs breathing and a squash impulse; the real animation curves
 * arrive with the behaviour state machine in phase 3.
 */
import { Sprite, type Texture } from 'pixi.js';

/** Peak vertical scale change while breathing (±2 %, ~3 s period). */
const BREATH_AMPLITUDE = 0.02;
const BREATH_PERIOD_SECONDS = 3;

/** How hard a poke squashes the pet, and how fast that decays. */
const SQUASH_STRENGTH = 0.18;
const SQUASH_DECAY_PER_SECOND = 4.5;

export class PetSprite {
  readonly view: Sprite;

  private baseScale = 1;
  private breathPhase = Math.random() * Math.PI * 2;
  private impulse = 0;
  private facing: 1 | -1 = 1;

  constructor(texture: Texture) {
    this.view = new Sprite(texture);
    // Anchored at the feet: `position.y` is where the pet touches the ground,
    // which is what `PetPhoto.anchorY` will describe from phase 2 on.
    this.view.anchor.set(0.5, 1);
    this.view.eventMode = 'static';
    this.view.cursor = 'grab';
    this.applyTransform();
  }

  /** Scales the sprite so it renders this tall (logical px) at rest. */
  setBaseHeight(pixels: number): void {
    const textureHeight = this.view.texture.height;
    this.baseScale = textureHeight > 0 ? pixels / textureHeight : 1;
    this.applyTransform();
  }

  get baseWidth(): number {
    return this.view.texture.width * this.baseScale;
  }

  get baseHeight(): number {
    return this.view.texture.height * this.baseScale;
  }

  get flipped(): boolean {
    return this.facing === -1;
  }

  setFacing(facing: 1 | -1): void {
    if (this.facing === facing) return;
    this.facing = facing;
    this.applyTransform();
  }

  setPosition(x: number, y: number): void {
    this.view.position.set(x, y);
  }

  get x(): number {
    return this.view.position.x;
  }

  get y(): number {
    return this.view.position.y;
  }

  /** A click, a drop, a bump — anything that should make the pet react. */
  poke(strength = 1): void {
    this.impulse = Math.min(1, this.impulse + strength);
  }

  update(deltaSeconds: number): void {
    this.breathPhase += (deltaSeconds / BREATH_PERIOD_SECONDS) * Math.PI * 2;
    if (this.breathPhase > Math.PI * 2) this.breathPhase -= Math.PI * 2;
    this.impulse = Math.max(0, this.impulse - deltaSeconds * SQUASH_DECAY_PER_SECOND);
    this.applyTransform();
  }

  /** Axis-aligned box of the drawn pixels, in stage (logical) coordinates. */
  bounds(): { x: number; y: number; width: number; height: number } {
    const width = Math.abs(this.view.scale.x) * this.view.texture.width;
    const height = Math.abs(this.view.scale.y) * this.view.texture.height;
    return {
      x: this.view.position.x - width / 2,
      y: this.view.position.y - height,
      width,
      height,
    };
  }

  private applyTransform(): void {
    const breath = Math.sin(this.breathPhase) * BREATH_AMPLITUDE;
    const squash = this.impulse * SQUASH_STRENGTH;
    // Squashing down widens the pet — volume roughly stays put.
    this.view.scale.set(
      this.baseScale * (1 - breath * 0.5 + squash * 0.8) * this.facing,
      this.baseScale * (1 + breath - squash),
    );
  }
}

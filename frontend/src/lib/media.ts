/** The subset of HTMLAudioElement the deck code uses, so a decoded-buffer engine can stand in for the element. */
export interface MediaLike extends EventTarget {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly error: unknown;
  readonly readyState: number;
  src: string;
  readonly currentSrc: string;
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch: boolean;
  volume: number;
  muted: boolean;
  /** Set by engines that render into the Web Audio graph themselves; elements need createMediaElementSource. */
  readonly output?: AudioNode;
  load(): void;
  unload(): void;
  play(): Promise<void>;
  pause(): void;
}

/** Adds `unload()` (replaces removeAttribute("src")) to the element itself, so its identity keys stay stable. */
export const elementMedia = (audio: HTMLAudioElement): HTMLAudioElement & MediaLike =>
  Object.assign(audio, { unload: () => { audio.pause(); audio.removeAttribute("src"); audio.load(); } });

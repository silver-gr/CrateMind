/// <reference types="vite/client" />

declare module "@fontsource-variable/inter";
declare module "@fontsource-variable/geist";
declare module "@fontsource/jetbrains-mono/*.css";
declare module "*.css";

/** True when the build found the private Maximizer engine (vite.config.ts). */
declare const __MAXIMIZER__: boolean | undefined;
declare module "virtual:maximizer-engine" {
  import type { Maximizer } from "@/lib/audio/maximizer";
  export function loadMaximizer(ctx: AudioContext): Promise<ArrayBuffer>;
  export function createMaximizer(ctx: AudioContext, wasm: ArrayBuffer): Maximizer;
}

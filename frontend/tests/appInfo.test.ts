import { describe, expect, test } from "bun:test";
import { runtimeLabel } from "../src/lib/appInfo";

const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";

describe("runtimeLabel", () => {
  test("the desktop shell's own report wins over the user agent", () => {
    // The macOS WebView says "Intel Mac OS X" on every Mac: only the shell knows the CPU.
    expect(runtimeLabel({ desktop: true, nativeHost: "macos aarch64", userAgent: SAFARI_MAC })).toBe("Desktop · macOS · Apple Silicon");
    expect(runtimeLabel({ desktop: true, nativeHost: "macos x86_64", userAgent: SAFARI_MAC })).toBe("Desktop · macOS · Intel");
    expect(runtimeLabel({ desktop: true, nativeHost: "windows x86_64", userAgent: EDGE_WIN })).toBe("Desktop · Windows · x64");
    expect(runtimeLabel({ desktop: true, nativeHost: "windows aarch64" })).toBe("Desktop · Windows · ARM64");
  });

  test("without a shell report the platform comes from the user agent and the CPU only from the browser", () => {
    expect(runtimeLabel({ desktop: false, userAgent: SAFARI_MAC })).toBe("Web · macOS");
    expect(runtimeLabel({ desktop: false, userAgent: SAFARI_MAC, browserArch: "arm" })).toBe("Web · macOS · Apple Silicon");
    expect(runtimeLabel({ desktop: false, userAgent: EDGE_WIN, browserArch: "x86" })).toBe("Web · Windows · x64");
    expect(runtimeLabel({ desktop: true, userAgent: EDGE_WIN })).toBe("Desktop · Windows");
  });

  test("unknown values are left out, never guessed", () => {
    expect(runtimeLabel({ desktop: false })).toBe("Web");
    expect(runtimeLabel({ desktop: false, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)" })).toBe("Web");
    expect(runtimeLabel({ desktop: true, nativeHost: "plan9 riscv64" })).toBe("Desktop");
    expect(runtimeLabel({ desktop: true, nativeHost: "macos riscv64" })).toBe("Desktop · macOS");
  });
});

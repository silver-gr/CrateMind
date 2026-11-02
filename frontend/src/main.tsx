import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./app/App";
import { PlayerProvider } from "./lib/player";
import { toast } from "sonner";
import { isDesktopRuntime, interceptExternalLinks } from "./lib/desktopRuntime";
import { loadPreferences, preferenceStorage } from "./lib/preferenceStorage";
import { applyTheme, getTheme } from "./lib/theme";
import { installMidiBridge } from "./lib/midi";
import { installScrollFades } from "./lib/scrollFades";
import "./lib/pwa"; // SW registration + early beforeinstallprompt capture
// Local fonts (bundled, no network) — Inter for UI, JetBrains Mono for tokens/numbers, Geist for the metallic wordmark.
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./index.css";

function PreferenceWriteNotice() {
  const error = React.useSyncExternalStore(preferenceStorage.subscribe, preferenceStorage.getError);
  return error ? <div role="alert" className="fixed bottom-4 left-4 z-[100] max-w-sm rounded-lg border border-cm-amber bg-cm-panel p-3 text-sm text-cm-text">
    <p>{error}</p><button type="button" className="mt-2 underline" onClick={() => {
      void preferenceStorage.flush().catch(() => {});
    }}>Νέα προσπάθεια αποθήκευσης</button>
  </div> : null;
}

installMidiBridge();
installScrollFades();

async function bootstrap() {
  try {
    await loadPreferences();
    applyTheme(getTheme());
    if (isDesktopRuntime()) {
      interceptExternalLinks(message => toast.error(message));
      window.addEventListener("pagehide", () => { void preferenceStorage.flush().catch(() => {}); });
    }
    ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PlayerProvider>
        <App />
        <PreferenceWriteNotice />
      </PlayerProvider>
    </BrowserRouter>
  </React.StrictMode>
    );
  } catch (error) {
    const root = document.getElementById("root")!;
    const message = document.createElement("p");
    message.textContent = `Δεν ήταν δυνατή η εκκίνηση. ${(error as Error).message}`;
    message.setAttribute("role", "alert");
    const retry = document.createElement("button");
    retry.textContent = "Νέα προσπάθεια";
    retry.onclick = () => { root.replaceChildren(); void bootstrap(); };
    root.replaceChildren(message, retry);
  }
}

void bootstrap();

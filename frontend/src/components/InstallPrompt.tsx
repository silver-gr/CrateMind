import { preferenceStorage } from "../lib/preferenceStorage";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { Button } from "./ui/button";
import { Download, Share, X } from "../lib/icons";
import { isIOS, promptInstall, useInstallPrompt } from "../lib/pwa";
import { isDesktopRuntime } from "../lib/desktopRuntime";

const DISMISS_KEY = "cm:install-dismissed-at";
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const SHOW_DELAY_MS = 4000; // let the app settle before asking

function recentlyDismissed(): boolean {
  try {
    return Date.now() - Number(preferenceStorage.getItem(DISMISS_KEY) ?? 0) < SNOOZE_MS;
  } catch {
    return false;
  }
}

/**
 * Custom "install CrateMind" card. Uses the captured beforeinstallprompt on
 * Chromium; on iOS Safari (no such event) it shows Share → Home Screen steps.
 * Dismissal snoozes it for 30 days.
 */
export default function InstallPrompt() {
  const { canPrompt, installed } = useInstallPrompt();
  // OS setting or the in-app «Μειωμένη κίνηση» (AppShell's MotionConfig).
  const reduceMotion = useReducedMotionConfig();
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(recentlyDismissed);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const visible = !isDesktopRuntime() && ready && !dismissed && !installed && (canPrompt || isIOS);

  const dismiss = () => {
    setDismissed(true);
    try {
      preferenceStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore quota / private-mode */
    }
  };

  const install = async () => {
    const accepted = await promptInstall();
    if (!accepted) dismiss();
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="dialog"
          aria-labelledby="cm-install-title"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
          transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
          className="glass-strong fixed right-4 left-4 z-50 rounded-2xl p-4 sm:left-auto sm:w-[360px]"
          style={{ bottom: "calc(var(--cm-player-height, 64px) + 16px)" }}
        >
          <button
            type="button"
            onClick={dismiss}
            aria-label="Κλείσιμο"
            className="absolute top-3 right-3 rounded-md p-1 text-cm-muted transition hover:bg-cm-contrast/5 hover:text-cm-text"
          >
            <X className="size-4" />
          </button>

          <div className="flex gap-3 pr-6">
            <img src="/icons/icon-192.png" alt="" className="size-12 shrink-0 rounded-xl" />
            <div className="min-w-0">
              <h2 id="cm-install-title" className="text-sm font-semibold text-cm-text">
                Εγκατάσταση CrateMind
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-cm-muted">
                {canPrompt
                  ? "Άνοιξέ το σαν εφαρμογή — σε δικό του παράθυρο, χωρίς καρτέλες browser."
                  : "Πάτησε Κοινοποίηση και μετά «Προσθήκη στην οθόνη Αφετηρίας»."}
              </p>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Όχι τώρα
            </Button>
            {canPrompt ? (
              <Button size="sm" onClick={install}>
                <Download />
                Εγκατάσταση
              </Button>
            ) : (
              <Button size="sm" onClick={dismiss}>
                <Share />
                Εντάξει
              </Button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

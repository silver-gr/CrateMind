import { toast } from "sonner";

/** Copies text for the menus' «Αντιγραφή»; the webview can refuse (no permission, no focus). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Αντιγράφηκε");
  } catch {
    toast.error("Δεν ήταν δυνατή η αντιγραφή");
  }
}

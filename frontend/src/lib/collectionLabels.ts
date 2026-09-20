/** Display aliases only; provider IDs and grouping keys remain source evidence. */
export function collectionAccountLabel(service: string, account?: string | number | null, fallback = "Προσωπική συλλογή") {
  if (service === "soundcloud" && String(account) === "7149789") return "DJ PanoramixXX";
  return account == null || account === "" ? fallback : String(account);
}

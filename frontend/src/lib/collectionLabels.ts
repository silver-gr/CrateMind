/** Display aliases only; provider IDs and grouping keys remain source evidence. */
export function collectionAccountLabel(service: string, account?: string | number | null, fallback = "Προσωπική συλλογή") {
  if (service === "soundcloud" && String(account) === "7149789") return "DJ PanoramixXX";
  return account == null || account === "" ? fallback : String(account);
}


export function collectionOriginLabel(collection: {service:string; source_services?:string[]; source_accounts?:string[]; provenance?:{account?:string}}) {
  const names:Record<string,string>={spotify:'Spotify',soundcloud:'SoundCloud',cratemind:'CrateMind'};
  const services=collection.source_services?.length?collection.source_services:[collection.service];
  const original=services.filter(service=>service!=='cratemind');
  const visible=original.length?original:services;
  const accounts=collection.source_accounts?.length?collection.source_accounts:collection.provenance?.account?[collection.provenance.account]:[];
  return [visible.map(service=>names[service]||service).join(' + '),...accounts.map(account=>collectionAccountLabel(visible.includes('soundcloud')?'soundcloud':visible[0],account,''))].join(' · ');
}

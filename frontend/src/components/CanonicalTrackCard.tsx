import { availabilityLabels } from "./CompletenessControls";
import { serviceLabel } from "./collections/kit";
import type { SoundCloudConfirmedMetadata } from "../lib/types";
import { NumberCount } from "./ui/NumberCount";

export type Canonical = {
  collection_memberships?: { id: string }[];
  availability?: { state: string };
  artist: string;
  title: string;
  recording_id: string;
  credits: { name: string; role: string }[];
  providers: {
    id: string;
    service: string;
    url: string | null;
    popularity: Record<string, number> | unknown[] | null;
    liked_in: { provenance: { account?: string } }[];
  }[];
};

export default function CanonicalTrackCard({ value, soundcloud }: {
  value: Canonical;
  soundcloud?: SoundCloudConfirmedMetadata | null;
}) {
  const collectionCount = new Set(value.collection_memberships?.map((collection) => collection.id)).size;
  const otherProviders = value.providers.filter((provider) => (
    provider.service !== "local" && !(provider.service === "soundcloud" && (
      provider.id === soundcloud?.counter_source_id || provider.id === soundcloud?.track.urn
    ))
  ));
  return (
    <div className="space-y-1.5 text-xs">
      {value.availability && (
        <p className="text-cm-muted">{availabilityLabels[value.availability.state]}</p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <a className="text-cm-cyan underline underline-offset-2" href={`/canonical?id=${encodeURIComponent(value.recording_id)}`}>
          Συλλογές (<NumberCount value={collectionCount} />)
        </a>
        <a className="text-cm-cyan underline underline-offset-2" href={`/provenance?recording=${encodeURIComponent(value.recording_id)}`}>
          Προέλευση
        </a>
      </div>
      {otherProviders.length > 0 && (
        <details className="text-cm-muted">
          <summary className="cursor-pointer">Άλλες πηγές</summary>
          <div className="mt-2 space-y-2">
            {otherProviders.map((provider) => {
              const popularity = Array.isArray(provider.popularity) ? null : provider.popularity;
              return (
                <div key={provider.id}>
                  {provider.url ? (
                    <a href={provider.url} target="_blank" rel="noreferrer" className="text-cm-cyan underline underline-offset-2">
                      {serviceLabel(provider.service)}
                    </a>
                  ) : <span>{serviceLabel(provider.service)}</span>}
                  {provider.liked_in.length > 0 && <span> · Αποθηκευμένο στα αγαπημένα</span>}
                  {provider.service === "soundcloud" && popularity && (
                    <p>
                      {popularity.playback_count == null ? "—" : <NumberCount value={popularity.playback_count} />} ακροάσεις
                      {" · "}{popularity.likes_count == null ? "—" : <NumberCount value={popularity.likes_count} />} «Μου αρέσει»
                      {" · "}{popularity.reposts_count == null ? "—" : <NumberCount value={popularity.reposts_count} />} κοινοποιήσεις
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

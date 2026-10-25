import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { CapabilitiesProvider, canAccessRoute, useCapabilities } from "../lib/capabilities";
import AppShell from "../components/layout/AppShell";
import { PageTransition } from "../components/ui/PageTransition";

const CollectionProvenance = lazy(() => import("../pages/CollectionProvenance"));
const Recovery = lazy(() => import("../pages/Recovery"));
const Collections = lazy(() => import("../pages/Collections"));
const CanonicalMetadata = lazy(() => import("../pages/CanonicalMetadata"));
const UnifiedLibrary = lazy(() => import("../pages/UnifiedLibrary"));
const Dashboard = lazy(() => import("../pages/Dashboard"));
const Duplicates = lazy(() => import("../pages/Duplicates"));
const Library = lazy(() => import("../pages/Library"));
const SetBuilder = lazy(() => import("../pages/SetBuilder"));
const Settings = lazy(() => import("../pages/Settings"));
const TaggingQueue = lazy(() => import("../pages/TaggingQueue"));
const Crates = lazy(() => import("../pages/Crates"));
const Playlists = lazy(() => import("../pages/Playlists"));
const SmartFolders = lazy(() => import("../pages/SmartFolders"));
const Artists = lazy(() => import("../pages/Artists"));
const Flow = lazy(() => import("../pages/Flow"));
const EnergyMaps = lazy(() => import("../pages/EnergyMaps"));
const KeyHarmony = lazy(() => import("../pages/KeyHarmony"));
const TagCloud = lazy(() => import("../pages/TagCloud"));
const PhraseFinder = lazy(() => import("../pages/PhraseFinder"));

function AppContent() {
  const location = useLocation();
  const capabilities = useCapabilities();
  return (
    <AppShell>
      <PageTransition key={location.pathname}>
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Φόρτωση...</div>}>
          {canAccessRoute(capabilities, location.pathname) ? <Routes location={location}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/provenance" element={<CollectionProvenance />} />
            <Route path="/recovery" element={<Recovery />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/canonical" element={<CanonicalMetadata />} />
            <Route path="/unified" element={<UnifiedLibrary />} />
            <Route path="/library" element={<Library />} />
            <Route path="/artists" element={<Artists />} />
            <Route path="/crates" element={<Crates />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/smart-folders" element={<SmartFolders />} />
            <Route path="/tag" element={<TaggingQueue />} />
            <Route path="/sets" element={<SetBuilder />} />
            <Route path="/flow" element={<Flow />} />
            <Route path="/energy-maps" element={<EnergyMaps />} />
            <Route path="/key-harmony" element={<KeyHarmony />} />
            <Route path="/tag-cloud" element={<TagCloud />} />
            <Route path="/phrase-finder" element={<PhraseFinder />} />
            <Route path="/duplicates" element={<Duplicates />} />
            <Route path="/settings" element={<Settings />} />
          </Routes> : (
            <div className="p-6 text-sm text-cm-text">
              <p>Η ενοποιημένη βιβλιοθήκη δεν είναι διαθέσιμη σε αυτή την εγκατάσταση.</p>
              <a href="/library" className="mt-3 inline-block text-cm-cyan">Άνοιγμα τοπικής βιβλιοθήκης</a>
            </div>
          )}
        </Suspense>
      </PageTransition>
    </AppShell>
  );
}

export default function App() {
  return <CapabilitiesProvider><AppContent /></CapabilitiesProvider>;
}

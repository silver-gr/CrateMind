import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import { PageTransition } from "../components/ui/PageTransition";
import Dashboard from "../pages/Dashboard";
import Duplicates from "../pages/Duplicates";
import Library from "../pages/Library";
import SetBuilder from "../pages/SetBuilder";
import Settings from "../pages/Settings";
import TaggingQueue from "../pages/TaggingQueue";
import Crates from "../pages/Crates";
import Playlists from "../pages/Playlists";
import SmartFolders from "../pages/SmartFolders";
import Flow from "../pages/Flow";
import EnergyMaps from "../pages/EnergyMaps";
import KeyHarmony from "../pages/KeyHarmony";
import TagCloud from "../pages/TagCloud";
import PhraseFinder from "../pages/PhraseFinder";

export default function App() {
  const location = useLocation();
  return (
    <AppShell>
      <PageTransition key={location.pathname}>
        <Routes location={location}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/library" element={<Library />} />
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
        </Routes>
      </PageTransition>
    </AppShell>
  );
}

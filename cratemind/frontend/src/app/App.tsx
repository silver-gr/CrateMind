import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import { PageTransition } from "../components/ui/PageTransition";
import Dashboard from "../pages/Dashboard";
import Duplicates from "../pages/Duplicates";
import Library from "../pages/Library";
import SetBuilder from "../pages/SetBuilder";
import Settings from "../pages/Settings";
import TaggingQueue from "../pages/TaggingQueue";

export default function App() {
  const location = useLocation();
  return (
    <AppShell>
      <PageTransition key={location.pathname}>
        <Routes location={location}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/library" element={<Library />} />
          <Route path="/tag" element={<TaggingQueue />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/sets" element={<SetBuilder />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </PageTransition>
    </AppShell>
  );
}

import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import MiniPlayer from "../components/MiniPlayer";
import Dashboard from "../pages/Dashboard";
import Library from "../pages/Library";
import TaggingQueue from "../pages/TaggingQueue";
import Duplicates from "../pages/Duplicates";
import SetBuilder from "../pages/SetBuilder";
import Settings from "../pages/Settings";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/library", label: "Library" },
  { to: "/tag", label: "Tagging Queue" },
  { to: "/duplicates", label: "Duplicates" },
  { to: "/sets", label: "Set Builder" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-6 border-b border-neutral-800 bg-neutral-950 px-5 py-3">
        <span className="text-lg font-bold tracking-tight text-emerald-400">CrateMind</span>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-sm ${
                  isActive
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-400 hover:text-white"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/library" element={<Library />} />
          <Route path="/tag" element={<TaggingQueue />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/sets" element={<SetBuilder />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <MiniPlayer />
    </div>
  );
}

import { useSyncExternalStore } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { session } from "./lib/api";
import { Layout } from "./components/Layout";
import { DevLoginPage } from "./pages/DevLoginPage";
import { OrgPickerPage } from "./pages/OrgPickerPage";
import { DashboardPage } from "./pages/DashboardPage";
import { JobsPage } from "./pages/JobsPage";
import { JobDetailPage } from "./pages/JobDetailPage";
import { PhotoSearchPage } from "./pages/PhotoSearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TeamPage } from "./pages/TeamPage";

function useSignedIn() {
  return useSyncExternalStore(session.subscribe, () => session.token !== null);
}

export function App() {
  const signedIn = useSignedIn();
  if (!signedIn) return <DevLoginPage />;
  return (
    <Routes>
      <Route path="/" element={<OrgPickerPage />} />
      <Route path="/orgs/:orgId" element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/:jobId" element={<JobDetailPage />} />
        <Route path="photos" element={<PhotoSearchPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

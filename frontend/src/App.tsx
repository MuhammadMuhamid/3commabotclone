import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ToastProvider } from "./components/ui";
import Dashboard  from "./pages/Dashboard";
import CreateBot  from "./pages/CreateBot";
import EditBot    from "./pages/EditBot";
import Settings   from "./pages/Settings";
import Login      from "./pages/Login";

export default function App() {
  return (
    /*
     * Outside AuthProvider, so a throw in auth bootstrapping is caught too —
     * that is the failure that would otherwise blank the page before anything
     * has rendered.
     */
    <ErrorBoundary>
    <AuthProvider>
      <ToastProvider />

      <Routes>
        {/* Public route */}
        <Route path="/login" element={<Login />} />

        {/* Protected routes — ProtectedRoute renders the nav + Outlet */}
        <Route element={<ProtectedRoute />}>
          <Route path="/"            element={<Dashboard />} />
          <Route path="/create"      element={<CreateBot />} />
          <Route path="/edit/:id"    element={<EditBot />} />
          <Route path="/settings"    element={<Settings />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
    </ErrorBoundary>
  );
}

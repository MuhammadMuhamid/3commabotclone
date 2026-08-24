import { Navigate, Outlet, Link } from "react-router-dom";
import { useLocation } from "react-router-dom";
import {
  Activity,
  LayoutDashboard,
  PlusCircle,
  Settings2,
  LogOut,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { Spinner, toast } from "./ui";

function NavLink({
  to,
  icon: Icon,
  label,
}: {
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  const { pathname } = useLocation();
  const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-all duration-150 ${
        active
          ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)] font-medium"
          : "text-[var(--color-muted)] hover:text-white hover:bg-[var(--color-panel-2)]"
      }`}
    >
      <Icon size={15} />
      {label}
    </Link>
  );
}

export function ProtectedRoute() {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const handleLogout = async () => {
    await logout();
    toast("Signed out", "success");
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      {/* Navigation */}
      <nav className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur-sm px-6 py-3 flex items-center gap-2">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 mr-4">
          <div className="w-7 h-7 rounded-lg bg-[var(--color-accent)] flex items-center justify-center">
            <Activity size={14} className="text-black" />
          </div>
          <span className="text-sm font-bold text-white tracking-tight">Signal Bot</span>
        </Link>

        <NavLink to="/"         icon={LayoutDashboard} label="Dashboard" />
        <NavLink to="/create"   icon={PlusCircle}      label="Create Bot" />
        <NavLink to="/settings" icon={Settings2}        label="Settings" />

        {/* Spacer + user info + logout */}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-[var(--color-muted)] hidden sm:block">
            {user.username}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg text-[var(--color-muted)] hover:text-white hover:bg-[var(--color-panel-2)] transition-all"
            title="Sign out"
          >
            <LogOut size={13} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </nav>

      {/* Page content */}
      <Outlet />
    </div>
  );
}

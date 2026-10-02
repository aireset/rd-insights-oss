import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
export function ProtectedRoute(): React.ReactElement {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <div className="auth-wrap muted">Carregando…</div>;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}

import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AppLayout } from './app/AppLayout';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage';
import { AcceptInvitePage } from './features/auth/AcceptInvitePage';
import { UsersPage } from './features/settings/UsersPage';
import { SecurityPage } from './features/settings/SecurityPage';
import { ConectarRdPage } from './features/onboarding/ConectarRdPage';
import { LeadsPage } from './features/leads/LeadsPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { SyncSchedulePage } from './features/sync/SyncSchedulePage';
import { queryClient } from './lib/queryClient';
import { AiConfigPage } from './features/ai/AiConfigPage';
import { ClassificationPage } from './features/ai/Classification';
import { TypedChatPage } from './features/ai/TypedChatPage';

/** Link antigo da ficha: a ficha agora é um popup sobre a lista. */
function LeadRedirect(): React.ReactElement {
  const { id = '' } = useParams();
  return <Navigate to={`/leads?lead=${encodeURIComponent(id)}`} replace />;
}

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/registrar" element={<RegisterPage />} />
            <Route path="/recuperar-senha" element={<ForgotPasswordPage />} />
            <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
            <Route path="/aceitar-convite" element={<AcceptInvitePage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                <Route index element={<Navigate to="/leads" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/leads" element={<LeadsPage />} />
                <Route path="/leads/:id" element={<LeadRedirect />} />
                <Route path="/conectar" element={<ConectarRdPage />} />
                <Route path="/sincronizacao" element={<SyncSchedulePage />} />
                <Route path="/configuracoes/usuarios" element={<UsersPage />} />
                <Route path="/configuracoes/seguranca" element={<SecurityPage />} />
                <Route path="/configuracao/ia" element={<AiConfigPage />} />
                <Route path="/ia/classificacao" element={<ClassificationPage />} />
                <Route path="/ia/chat" element={<TypedChatPage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

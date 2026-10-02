import { BarChart3, Bot, LogOut, MessageCircle, Plug, RefreshCw, Settings, ShieldCheck, Users } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Avatar } from '../components/Avatar';
import styles from './AppLayout.module.scss';

const NAV = [
  { to: '/sincronizacao', label: 'Sincronização', icon: RefreshCw },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/dashboard', label: 'Dashboard', icon: BarChart3 },
  { to: '/conectar', label: 'Conexão RD', icon: Plug },
  { to: '/ia/chat', label: 'Pergunte à base', icon: MessageCircle },
];

export function AppLayout(): React.ReactElement {
  const { user, logout } = useAuth();
  const nome = user?.name ?? user?.email ?? '?';
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}><span className={styles.brandMark}>RD</span>RD Insights</div>
        <div className={styles.headerRight}>
          <div className={styles.who}><div className={styles.whoName}>{user?.accountName}</div><div className={styles.whoMail}>{user?.email}</div></div>
          <Avatar name={nome} size={34} />
        </div>
      </header>

      <aside className={styles.sidebar}>
        <div className={styles.sideInner}>
        <nav className={styles.sideNav} aria-label="Principal">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}><Icon size={18} /> {label}</NavLink>
          ))}
          {user?.role === 'admin' && <NavLink to="/configuracoes/usuarios" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}><Settings size={18} /> Usuários</NavLink>}
          <NavLink to="/configuracoes/seguranca" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}><ShieldCheck size={18} /> Segurança</NavLink>
          {user?.role === 'admin' && <NavLink to="/configuracao/ia" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}><Bot size={18} /> Configuração de IA</NavLink>}
          {user?.role === 'admin' && <NavLink to="/ia/classificacao" className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}><Bot size={18} /> Classificação</NavLink>}
        </nav>
        <div className={styles.sideFoot}>
          <div className={styles.account}>
            <Avatar name={nome} size={28} />
            <div className={styles.accountInfo}><div className={styles.accountName}>{nome}</div><div className={styles.accountRole}>{user?.accountName}</div></div>
          </div>
          <button type="button" className={styles.sair} onClick={() => void logout()}><LogOut size={18} /> Sair</button>
        </div>
        </div>
      </aside>

      <main className={styles.content}><Outlet /></main>

      <nav className={styles.bnav} aria-label="Principal (mobile)">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `${styles.bnavItem} ${isActive ? styles.active : ''}`}><Icon size={22} />{label}</NavLink>
        ))}
        {user?.role === 'admin' && <NavLink to="/configuracoes/usuarios" className={({ isActive }) => `${styles.bnavItem} ${isActive ? styles.active : ''}`}><Settings size={22} />Usuários</NavLink>}
        <NavLink to="/configuracoes/seguranca" className={({ isActive }) => `${styles.bnavItem} ${isActive ? styles.active : ''}`}><ShieldCheck size={22} />Segurança</NavLink>
        <button type="button" className={styles.bnavItem} onClick={() => void logout()}><LogOut size={22} />Sair</button>
      </nav>
    </div>
  );
}

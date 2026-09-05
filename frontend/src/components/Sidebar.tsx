import { NavLink } from 'react-router-dom';
import { useAuth } from '../AuthContext';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { user, logout } = useAuth();

  return (
    <>
      {open && <div className="modal-overlay" style={{ zIndex: 99 }} onClick={onClose} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="sidebar-logo-icon">R</div>
            <span className="sidebar-logo-text">ReachInbox</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <span className="sidebar-section-label">Dashboard</span>
          <NavLink
            to="/"
            end
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            onClick={onClose}
          >
            <span className="sidebar-link-icon">📊</span>
            Overview
          </NavLink>

          <span className="sidebar-section-label">Emails</span>
          <NavLink
            to="/scheduled"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            onClick={onClose}
          >
            <span className="sidebar-link-icon">📅</span>
            Scheduled
          </NavLink>
          <NavLink
            to="/sent"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            onClick={onClose}
          >
            <span className="sidebar-link-icon">✅</span>
            Sent
          </NavLink>
          <NavLink
            to="/compose"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            onClick={onClose}
          >
            <span className="sidebar-link-icon">✏️</span>
            Compose
          </NavLink>

          <span className="sidebar-section-label">Integrations</span>
          <NavLink
            to="/slack"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            onClick={onClose}
          >
            <span className="sidebar-link-icon">💬</span>
            Slack
          </NavLink>

          <span className="sidebar-section-label">System</span>
          <a
            href="/admin/queues"
            target="_blank"
            rel="noopener noreferrer"
            className="sidebar-link"
          >
            <span className="sidebar-link-icon">⚙️</span>
            Queue Dashboard
          </a>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user" onClick={logout} title="Click to logout">
            <div className="sidebar-avatar">
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt={user.name} referrerPolicy="no-referrer" />
              ) : (
                user?.name?.charAt(0).toUpperCase() || '?'
              )}
            </div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user?.name || 'User'}</div>
              <div className="sidebar-user-email">{user?.email || ''}</div>
            </div>
            <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>↪</span>
          </div>
        </div>
      </aside>
    </>
  );
}

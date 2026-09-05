import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { authApi } from '../api';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    // Handle auth errors from Google callback
    const authError = searchParams.get('auth_error');
    if (authError) {
      toast.error(`Login failed: ${authError}`);
      window.history.replaceState({}, '', '/login');
    }
  }, [searchParams]);

  useEffect(() => {
    if (!loading && user) {
      navigate('/', { replace: true });
    }
  }, [user, loading, navigate]);

  const handleLogin = () => {
    window.location.href = authApi.getGoogleAuthUrl();
  };

  if (loading) {
    return (
      <div className="login-page">
        <div className="loading-state">
          <div className="spinner" />
          <div className="loading-text">Checking session...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">R</div>
        <h1 className="login-title">ReachInbox</h1>
        <p className="login-subtitle">
          Schedule, manage, and track email campaigns with intelligent rate
          limiting and real-time notifications.
        </p>

        <button className="login-btn" onClick={handleLogin} id="google-login-btn">
          <svg viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>

        <div className="login-features">
          <div className="login-feature">
            <span className="login-feature-icon">📧</span>
            <span>Email Scheduling</span>
          </div>
          <div className="login-feature">
            <span className="login-feature-icon">⚡</span>
            <span>Rate Limiting</span>
          </div>
          <div className="login-feature">
            <span className="login-feature-icon">🔔</span>
            <span>Slack Alerts</span>
          </div>
          <div className="login-feature">
            <span className="login-feature-icon">🔍</span>
            <span>Full-Text Search</span>
          </div>
        </div>
      </div>
    </div>
  );
}

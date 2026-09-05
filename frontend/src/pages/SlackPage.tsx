import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { slackApi, type SlackStatus } from '../api';
import toast from 'react-hot-toast';

export default function SlackPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const s = await slackApi.getStatus();
      setStatus(s);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Handle Slack OAuth callback query params
    const connected = searchParams.get('slack_connected');
    const error = searchParams.get('slack_error');

    if (connected === 'true') {
      toast.success('Slack connected successfully!');
      setSearchParams({}, { replace: true });
    } else if (error) {
      toast.error(`Slack connection failed: ${error}`);
      setSearchParams({}, { replace: true });
    }

    fetchStatus();
  }, [searchParams, setSearchParams, fetchStatus]);

  const handleConnect = () => {
    window.location.href = slackApi.getOAuthUrl();
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect Slack?')) return;
    try {
      setDisconnecting(true);
      await slackApi.disconnect();
      toast.success('Slack disconnected');
      await fetchStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Slack Integration</h1>
        <p className="page-subtitle">Connect Slack to receive rate-limit notifications.</p>
      </div>

      <div className="page-body" style={{ maxWidth: 640 }}>
        {loading ? (
          <div className="loading-state">
            <div className="spinner" />
            <div className="loading-text">Checking Slack status...</div>
          </div>
        ) : (
          <>
            {/* Connection Status Card */}
            <div className="card" style={{ marginBottom: 24 }}>
              <div className="card-header">
                <h3 className="card-title">Connection Status</h3>
                <div className={`slack-status-dot ${status?.connected ? 'connected' : 'disconnected'}`} />
              </div>
              <div className="card-body">
                {status?.connected ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Status</span>
                        <span className="badge badge-sent">Connected</span>
                      </div>
                      {status.workspace?.name && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Workspace</span>
                          <span style={{ fontWeight: 600 }}>{status.workspace.name}</span>
                        </div>
                      )}
                      {status.slackUserId && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Slack User ID</span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                            {status.slackUserId}
                          </span>
                        </div>
                      )}
                    </div>

                    <button
                      className="btn btn-danger"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      id="disconnect-slack-btn"
                    >
                      {disconnecting ? 'Disconnecting...' : '🔌 Disconnect Slack'}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '16px 0' }}>
                    <div style={{ fontSize: '2.5rem' }}>💬</div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>Slack not connected</div>
                      <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', maxWidth: 320 }}>
                        Connect your Slack workspace to receive real-time notifications when email rate limits are reached.
                      </div>
                    </div>
                    <button className="btn btn-primary btn-lg" onClick={handleConnect} id="connect-slack-btn">
                      🔗 Connect Slack
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Info Card */}
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">ℹ️ How it works</h3>
              </div>
              <div className="card-body" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                <ul style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <li>When your email sending rate exceeds the configured hourly limit, a notification is automatically sent to your connected Slack channel.</li>
                  <li>Notifications include details about the rate limit event, the affected email, and the current usage.</li>
                  <li>Duplicate notifications for the same sender within the same rate-limit window are suppressed.</li>
                  <li>Your Slack connection is securely stored and never exposes access tokens.</li>
                </ul>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

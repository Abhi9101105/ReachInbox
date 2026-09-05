import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { emailApi, systemApi, slackApi, type RateLimitStatus, type QueueStatus, type SlackStatus } from '../api';

export default function OverviewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    scheduled: 0,
    sent: 0,
    failed: 0,
    total: 0,
  });
  const [rateLimit, setRateLimit] = useState<RateLimitStatus | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [scheduledRes, sentRes, failedRes, rlRes, qRes, slRes] = await Promise.allSettled([
        emailApi.list({ status: 'SCHEDULED', limit: 1 }),
        emailApi.list({ status: 'SENT', limit: 1 }),
        emailApi.list({ status: 'FAILED', limit: 1 }),
        systemApi.rateLimitStatus(),
        systemApi.queueStatus(),
        slackApi.getStatus(),
      ]);

      const scheduled = scheduledRes.status === 'fulfilled' ? scheduledRes.value.pagination.total : 0;
      const sent = sentRes.status === 'fulfilled' ? sentRes.value.pagination.total : 0;
      const failed = failedRes.status === 'fulfilled' ? failedRes.value.pagination.total : 0;
      setStats({ scheduled, sent, failed, total: scheduled + sent + failed });

      if (rlRes.status === 'fulfilled') setRateLimit(rlRes.value);
      if (qRes.status === 'fulfilled') setQueueStatus(qRes.value);
      if (slRes.status === 'fulfilled') setSlackStatus(slRes.value);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Welcome back, {user?.name?.split(' ')[0]} 👋</h1>
        <p className="page-subtitle">Here's what's happening with your email campaigns.</p>
      </div>

      <div className="page-body">
        {loading ? (
          <div className="loading-state">
            <div className="spinner" />
            <div className="loading-text">Loading dashboard...</div>
          </div>
        ) : (
          <>
            {/* Stats Row */}
            <div className="stats-row" style={{ marginBottom: 24 }}>
              <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/scheduled')}>
                <div className="stat-value" style={{ color: 'var(--info)' }}>{stats.scheduled}</div>
                <div className="stat-label">Scheduled</div>
              </div>
              <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/sent')}>
                <div className="stat-value" style={{ color: 'var(--success)' }}>{stats.sent}</div>
                <div className="stat-label">Sent</div>
              </div>
              <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/sent')}>
                <div className="stat-value" style={{ color: 'var(--error)' }}>{stats.failed}</div>
                <div className="stat-label">Failed</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.total}</div>
                <div className="stat-label">Total Emails</div>
              </div>
            </div>

            {/* Rate Limit + Queue + Slack */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
              {/* Rate Limit Card */}
              {rateLimit && (
                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title">⚡ Rate Limit</h3>
                  </div>
                  <div className="card-body">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Current Usage</span>
                      <span style={{ fontWeight: 700 }}>{rateLimit.currentCount} / {rateLimit.limit}</span>
                    </div>
                    <div style={{
                      height: 6,
                      background: 'var(--bg-tertiary)',
                      borderRadius: 3,
                      overflow: 'hidden',
                      marginBottom: 16,
                    }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.min(100, (rateLimit.currentCount / rateLimit.limit) * 100)}%`,
                        background: rateLimit.currentCount >= rateLimit.limit ? 'var(--error)' : 'var(--accent-primary)',
                        borderRadius: 3,
                        transition: 'width 0.5s ease',
                      }} />
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div>Min delay: {rateLimit.minSendDelayMs}ms</div>
                      <div>Window: {rateLimit.windowSeconds}s</div>
                      <div>Workers: {rateLimit.workerConcurrency}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Queue Status Card */}
              {queueStatus && (
                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title">⚙️ Queue Status</h3>
                    <a href="/admin/queues" target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-secondary">
                      Bull Board →
                    </a>
                  </div>
                  <div className="card-body">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {Object.entries(queueStatus.counts).map(([key, value]) => (
                        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                          <span style={{ color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{key}</span>
                          <span style={{ fontWeight: 600 }}>{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Slack Status Card */}
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">💬 Slack</h3>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => navigate('/slack')}
                  >
                    Manage
                  </button>
                </div>
                <div className="card-body">
                  <div className="slack-card" style={{ border: 'none', padding: 0, background: 'transparent' }}>
                    <div className={`slack-status-dot ${slackStatus?.connected ? 'connected' : 'disconnected'}`} />
                    <div className="slack-info">
                      <div className="slack-label">
                        {slackStatus?.connected ? 'Connected' : 'Not Connected'}
                      </div>
                      {slackStatus?.connected && slackStatus.workspace?.name && (
                        <div className="slack-detail">Workspace: {slackStatus.workspace.name}</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Action */}
            <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
              <button className="btn btn-primary btn-lg" onClick={() => navigate('/compose')}>
                ✏️ Compose New Email
              </button>
              <button className="btn btn-secondary btn-lg" onClick={fetchData}>
                🔄 Refresh
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

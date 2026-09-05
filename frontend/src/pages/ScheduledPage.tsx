import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { emailApi, type Email, type EmailListResponse } from '../api';
import EmailTable from '../components/EmailTable';
import toast from 'react-hot-toast';

export default function ScheduledPage() {
  const navigate = useNavigate();
  const [emails, setEmails] = useState<Email[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchEmails = useCallback(async (page: number = 1) => {
    try {
      setLoading(true);
      setError(null);
      let result: EmailListResponse;

      if (searchQuery.trim()) {
        const searchRes = await emailApi.search({ q: searchQuery.trim(), status: 'SCHEDULED', page, limit: 20 });
        result = {
          success: true,
          emails: searchRes.emails || [],
          pagination: { page: searchRes.page, limit: searchRes.limit, total: searchRes.total, totalPages: Math.ceil(searchRes.total / searchRes.limit) },
        };
      } else {
        result = await emailApi.list({ status: 'SCHEDULED', page, limit: 20 });
      }

      setEmails(result.emails);
      setPagination(result.pagination);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load emails';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchEmails(1);
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Scheduled Emails</h1>
        <p className="page-subtitle">Emails queued and waiting to be sent.</p>
      </div>

      <div className="page-body">
        {/* Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 16, flexWrap: 'wrap' }}>
          <form onSubmit={handleSearch} className="search-bar" style={{ flex: 1 }}>
            <span className="search-bar-icon">🔍</span>
            <input
              type="text"
              placeholder="Search scheduled emails..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              id="search-scheduled"
            />
          </form>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => fetchEmails(pagination.page)}>
              🔄 Refresh
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/compose')}>
              ✏️ Compose
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="card">
          {loading ? (
            <div className="loading-state">
              <div className="spinner" />
              <div className="loading-text">Loading scheduled emails...</div>
            </div>
          ) : error ? (
            <div className="empty-state">
              <div className="empty-state-icon">⚠️</div>
              <div className="empty-state-title">Error loading emails</div>
              <div className="empty-state-text">{error}</div>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => fetchEmails()}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <EmailTable emails={emails} />
              {pagination.totalPages > 1 && (
                <div className="pagination" style={{ padding: '12px 16px', borderTop: '1px solid var(--border-primary)' }}>
                  <div className="pagination-info">
                    Showing {emails.length} of {pagination.total} emails
                  </div>
                  <div className="pagination-buttons">
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={pagination.page <= 1}
                      onClick={() => fetchEmails(pagination.page - 1)}
                    >
                      ← Prev
                    </button>
                    <span style={{ padding: '6px 12px', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                      {pagination.page} / {pagination.totalPages}
                    </span>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={pagination.page >= pagination.totalPages}
                      onClick={() => fetchEmails(pagination.page + 1)}
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

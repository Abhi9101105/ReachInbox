import { type Email } from '../api';

interface EmailTableProps {
  emails: Email[];
  showSentAt?: boolean;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function StatusBadge({ status }: { status: string }) {
  const cls = status.toLowerCase();
  return <span className={`badge badge-${cls}`}>{status}</span>;
}

export default function EmailTable({ emails, showSentAt = false }: EmailTableProps) {
  if (emails.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📭</div>
        <div className="empty-state-title">No emails found</div>
        <div className="empty-state-text">
          Emails matching your current filters will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="table-container">
      <table className="table">
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Subject</th>
            <th>{showSentAt ? 'Sent At' : 'Scheduled At'}</th>
            <th>Status</th>
            {showSentAt && <th>Preview</th>}
          </tr>
        </thead>
        <tbody>
          {emails.map((email) => (
            <tr key={email.id}>
              <td>
                <span className="truncate" style={{ display: 'block' }} title={email.recipient}>
                  {email.recipient}
                </span>
              </td>
              <td>
                <span className="truncate" style={{ display: 'block' }} title={email.subject}>
                  {email.subject}
                </span>
              </td>
              <td style={{ whiteSpace: 'nowrap', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                {formatDate(showSentAt && email.sentAt ? email.sentAt : email.scheduledAt)}
              </td>
              <td>
                <StatusBadge status={email.status} />
                {email.errorMessage && (
                  <div style={{ fontSize: '0.6875rem', color: 'var(--error)', marginTop: 2, maxWidth: 200 }} title={email.errorMessage}>
                    {email.errorMessage.substring(0, 60)}...
                  </div>
                )}
              </td>
              {showSentAt && (
                <td>
                  {email.previewUrl ? (
                    <a href={email.previewUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-secondary">
                      View
                    </a>
                  ) : (
                    <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { emailApi } from '../api';
import toast from 'react-hot-toast';

// Robust email parsing: supports CSV, comma-separated, semicolon-separated, newline-separated
function parseRecipients(raw: string): { valid: string[]; invalid: string[] } {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];

  // Split by common delimiters
  const tokens = raw
    .split(/[,;\n\r]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Skip CSV header
  const firstToken = tokens[0]?.toLowerCase();
  const startIdx = firstToken === 'email' || firstToken === 'emails' || firstToken === 'e-mail' || firstToken === 'recipient' ? 1 : 0;

  for (let i = startIdx; i < tokens.length; i++) {
    const email = tokens[i].toLowerCase().replace(/^["']|["']$/g, ''); // Strip quotes
    if (!email) continue;
    if (emailRegex.test(email)) {
      if (!seen.has(email)) {
        seen.add(email);
        valid.push(email);
      }
    } else {
      invalid.push(tokens[i]);
    }
  }

  return { valid, invalid };
}

export default function ComposePage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [recipientText, setRecipientText] = useState('');
  const [validRecipients, setValidRecipients] = useState<string[]>([]);
  const [invalidRecipients, setInvalidRecipients] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState(false);

  const updateRecipients = useCallback((text: string) => {
    setRecipientText(text);
    const { valid, invalid } = parseRecipients(text);
    setValidRecipients(valid);
    setInvalidRecipients(invalid);
  }, []);

  const handleFileUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        updateRecipients(content);
        toast.success(`File loaded: ${file.name}`);
      }
    };
    reader.onerror = () => toast.error('Failed to read file');
    reader.readAsText(file);
  }, [updateRecipients]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.name.endsWith('.csv') || file.name.endsWith('.txt') || file.type === 'text/plain' || file.type === 'text/csv')) {
      handleFileUpload(file);
    } else {
      toast.error('Please drop a .csv or .txt file');
    }
  }, [handleFileUpload]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
    e.target.value = '';
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!subject.trim()) newErrors.subject = 'Subject is required';
    if (!body.trim()) newErrors.body = 'Email body is required';
    if (validRecipients.length === 0) newErrors.recipients = 'At least one valid recipient email is required';

    if (scheduledAt) {
      const scheduled = new Date(scheduledAt);
      if (isNaN(scheduled.getTime())) {
        newErrors.scheduledAt = 'Invalid date/time';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate() || submitting) return;

    setSubmitting(true);
    try {
      const scheduleIso = scheduledAt ? new Date(scheduledAt).toISOString() : undefined;

      if (validRecipients.length === 1) {
        await emailApi.schedule({
          recipient: validRecipients[0],
          subject: subject.trim(),
          body: body.trim(),
          scheduledAt: scheduleIso,
        });
      } else {
        await emailApi.scheduleBatch({
          recipients: validRecipients,
          subject: subject.trim(),
          body: body.trim(),
          scheduledAt: scheduleIso,
        });
      }

      toast.success(`${validRecipients.length} email${validRecipients.length > 1 ? 's' : ''} scheduled successfully!`);
      navigate('/scheduled');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to schedule emails';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // Minimum datetime for scheduling (now)
  const minDateTime = new Date(Date.now() + 60000).toISOString().slice(0, 16);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Compose Email</h1>
        <p className="page-subtitle">Create and schedule emails to one or many recipients.</p>
      </div>

      <div className="page-body">
        <form onSubmit={handleSubmit} style={{ maxWidth: 720 }}>
          {/* Recipients */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <h3 className="card-title">📬 Recipients</h3>
              {validRecipients.length > 0 && (
                <span className="recipient-count">
                  ✅ {validRecipients.length} valid recipient{validRecipients.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="card-body">
              <div
                className={`recipient-area ${dragOver ? 'drag-over' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                style={{ marginBottom: 14 }}
              >
                <div className="recipient-area-label">📎 Drop a CSV/TXT file here or click to upload</div>
                <div className="recipient-area-sublabel">Supports .csv and .txt files with email addresses</div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  className="recipient-file-input"
                  onChange={handleFileChange}
                  id="file-upload"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Or paste emails directly</label>
                <textarea
                  className="form-textarea"
                  placeholder={"alice@example.com\nbob@example.com\n\nOR\n\nalice@example.com, bob@example.com"}
                  value={recipientText}
                  onChange={(e) => updateRecipients(e.target.value)}
                  rows={5}
                  id="recipient-input"
                />
                <div className="form-help">
                  Supports comma-separated, semicolon-separated, or one email per line. CSV headers are auto-detected.
                </div>
                {errors.recipients && <div className="form-error">{errors.recipients}</div>}
                {invalidRecipients.length > 0 && (
                  <div className="form-error">
                    {invalidRecipients.length} invalid address{invalidRecipients.length > 1 ? 'es' : ''}: {invalidRecipients.slice(0, 5).join(', ')}
                    {invalidRecipients.length > 5 ? '...' : ''}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Email Content */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <h3 className="card-title">✉️ Email Content</h3>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="subject-input">Subject</label>
                <input
                  type="text"
                  className="form-input"
                  id="subject-input"
                  placeholder="Enter email subject..."
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
                {errors.subject && <div className="form-error">{errors.subject}</div>}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="body-input">Body</label>
                <textarea
                  className="form-textarea"
                  id="body-input"
                  placeholder="Enter email body..."
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                />
                {errors.body && <div className="form-error">{errors.body}</div>}
              </div>
            </div>
          </div>

          {/* Scheduling Options */}
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
              <h3 className="card-title">🕐 Scheduling</h3>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="schedule-time">Start Time</label>
                <input
                  type="datetime-local"
                  className="form-input"
                  id="schedule-time"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  min={minDateTime}
                />
                <div className="form-help">
                  Leave empty to send immediately. Set a future time to schedule for later.
                </div>
                {errors.scheduledAt && <div className="form-error">{errors.scheduledAt}</div>}
              </div>

              <div style={{ padding: 14, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)', fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--text-primary)' }}>ℹ️ How scheduling works:</strong>
                <ul style={{ marginTop: 6, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <li><strong>Minimum delay</strong> controls spacing between individual sends (server-configured).</li>
                  <li><strong>Hourly limit</strong> caps maximum sends in a rolling hour window (server-configured).</li>
                  <li>Emails exceeding the limit remain queued and <strong>resume automatically</strong> when the window resets.</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={submitting || validRecipients.length === 0}
              id="schedule-btn"
            >
              {submitting ? (
                <>
                  <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                  Scheduling...
                </>
              ) : (
                <>📨 Schedule {validRecipients.length > 0 ? `${validRecipients.length} Email${validRecipients.length > 1 ? 's' : ''}` : 'Emails'}</>
              )}
            </button>
            <button type="button" className="btn btn-secondary btn-lg" onClick={() => navigate('/')}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

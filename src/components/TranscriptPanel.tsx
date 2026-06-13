import { useEffect, useState } from 'react';
import { useStore } from '../state/store';

export function TranscriptPanel() {
  const transcripts = useStore((s) => s.transcripts);
  const queryTranscripts = useStore((s) => s.queryTranscripts);
  const loading = useStore((s) => s.loading);
  const [search, setSearch] = useState('');
  const [receiverFilter, setReceiverFilter] = useState<string>('');

  useEffect(() => {
    queryTranscripts(receiverFilter || undefined, undefined, search || undefined);
  }, [queryTranscripts, receiverFilter, search]);

  const formatTime = (ms: number) => new Date(ms).toISOString().substr(11, 8);

  return (
    <div>
      <h2 style={{ marginBottom: '16px' }}>Transcripts</h2>
      
      {/* Search bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input
          placeholder="Search transcripts..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <select
          value={receiverFilter}
          onChange={e => setReceiverFilter(e.target.value)}
          style={inputStyle}
        >
          <option value="">All Receivers</option>
          {useStore.getState().receivers.map(r => (
            <option key={r.id} value={r.id}>{r.label || r.url}</option>
          ))}
        </select>
      </div>

      {/* Transcript list */}
      <div style={{ background: '#16213e', borderRadius: '8px', border: '1px solid #0f3460', maxHeight: '500px', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#aaa' }}>Loading...</div>
        ) : transcripts.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#666' }}>No transcripts yet</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #0f3460' }}>
                <th style={thStyle}>Time</th>
                <th style={thStyle}>Receiver</th>
                <th style={thStyle}>Mode</th>
                <th style={thStyle}>Language</th>
                <th style={thStyle}>Text (EN)</th>
              </tr>
            </thead>
            <tbody>
              {transcripts.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #0a0a1a' }}>
                  <td style={tdStyle}>{formatTime(t.ts_start)}</td>
                  <td style={tdStyle}>{t.receiver_id}</td>
                  <td style={tdStyle}>{t.mode.toUpperCase()}</td>
                  <td style={tdStyle}>{t.src_lang || (t.lane === 'digital' ? 'DIGITAL' : '-')}</td>
                  <td style={{ ...tdStyle, maxWidth: '400px' }}>{t.text_en}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', color: '#aaa', fontSize: '12px', textTransform: 'uppercase' };
const tdStyle: React.CSSProperties = { padding: '8px 12px', fontSize: '13px' };
const inputStyle: React.CSSProperties = { padding: '8px 12px', background: '#0a0a1a', color: '#e0e0e0', border: '1px solid #0f3460', borderRadius: '4px' };

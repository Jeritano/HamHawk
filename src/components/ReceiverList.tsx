import { useEffect, useState } from 'react';
import { useStore, ReceiverConfig } from '../state/store';

export function ReceiverList() {
  const receivers = useStore((s) => s.receivers);
  const loadReceivers = useStore((s) => s.loadReceivers);
  const removeReceiver = useStore((s) => s.removeReceiver);
  const startReceiver = useStore((s) => s.startReceiver);
  const stopReceiver = useStore((s) => s.stopReceiver);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const loading = useStore((s) => s.loading);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    kind: 'kiwisdr' as ReceiverConfig['kind'],
    url: '',
    label: '',
    freq_hz: 0,
    mode: 'lsb',
    lane: 'voice' as ReceiverConfig['lane'],
  });

  useEffect(() => { loadReceivers(); }, [loadReceivers]);

  // Update default mode when lane changes
  useEffect(() => {
    if (form.lane === 'voice' && !['lsb', 'usb', 'am', 'cw'].includes(form.mode)) {
      setForm({...form, mode: 'lsb'});
    } else if (form.lane === 'digital' && !['ft8', 'ft4', 'cw', 'psk31', 'rtty'].includes(form.mode)) {
      setForm({...form, mode: 'ft8'});
    }
  }, [form.lane, form.mode]);

  const handleAdd = async () => {
    if (!form.url || !form.freq_hz) return;
    await useStore.getState().addReceiver(form);
    setShowForm(false);
    setForm({ kind: 'kiwisdr', url: '', label: '', freq_hz: 0, mode: 'lsb', lane: 'voice' });
  };

  const handleStart = async (id: string) => {
    await startReceiver(id);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2>Receivers</h2>
        <button onClick={() => setShowForm(!showForm)} style={btnStyle}>
          {showForm ? 'Cancel' : '+ Add Receiver'}
        </button>
      </div>

      {showForm && (
        <div style={{ background: '#16213e', padding: '16px', borderRadius: '8px', marginBottom: '16px', border: '1px solid #0f3460' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <select value={form.kind} onChange={e => setForm({...form, kind: e.target.value as ReceiverConfig['kind']})} style={inputStyle}>
              <option value="kiwisdr">KiwiSDR</option>
              <option value="openwebrx">OpenWebRX</option>
            </select>
            <select value={form.mode} onChange={e => setForm({...form, mode: e.target.value})} style={inputStyle}>
              {form.lane === 'voice' ? (
                <>
                  <option value="lsb">LSB</option>
                  <option value="usb">USB</option>
                  <option value="am">AM</option>
                  <option value="cw">CW</option>
                </>
              ) : (
                <>
                  <option value="ft8">FT8</option>
                  <option value="ft4">FT4</option>
                  <option value="cw">CW</option>
                  <option value="psk31">PSK31</option>
                  <option value="rtty">RTTY</option>
                </>
              )}
            </select>
            <input placeholder="URL (ws://host:port)" value={form.url} onChange={e => setForm({...form, url: e.target.value})} style={inputStyle} />
            <input type="number" placeholder="Frequency (Hz)" value={form.freq_hz || ''} onChange={e => setForm({...form, freq_hz: Number(e.target.value)})} style={inputStyle} />
            <input placeholder="Label (optional)" value={form.label || ''} onChange={e => setForm({...form, label: e.target.value})} style={inputStyle} />
            <select value={form.lane} onChange={e => setForm({...form, lane: e.target.value as ReceiverConfig['lane']})} style={inputStyle}>
              <option value="voice">Voice</option>
              <option value="digital">Digital</option>
            </select>
          </div>
          <button onClick={handleAdd} disabled={loading} style={{ ...btnStyle, marginTop: '12px', width: '100%' }}>
            {loading ? 'Adding...' : 'Save'}
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gap: '8px' }}>
        {receivers.map(r => (
          <div key={r.id} style={{ background: '#16213e', padding: '12px 16px', borderRadius: '8px', border: '1px solid #0f3460', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong style={{ color: '#e94560' }}>{r.label || r.url}</strong>
              <span style={{ marginLeft: '12px', color: '#aaa', fontSize: '13px' }}>
                {r.kind} · {(r.freq_hz / 1e6).toFixed(3)} MHz · {r.mode.toUpperCase()} · {r.lane}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <StatusBadge status={sessionStatus[r.id]} />
              <button onClick={() => handleStart(r.id)} disabled={loading} style={btnStyle}>
                Start
              </button>
              <button onClick={() => stopReceiver(r.id)} style={btnStyle}>
                Stop
              </button>
              <button onClick={() => removeReceiver(r.id)} style={{ ...btnStyle, background: '#c0392b' }}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const s = status ?? 'stopped';
  const color: Record<string, string> = {
    live: '#2ecc71',
    connecting: '#f39c12',
    reconnecting: '#f39c12',
    error: '#e74c3c',
    stopped: '#666',
  };
  return (
    <span
      title={s}
      style={{
        fontSize: '11px',
        textTransform: 'uppercase',
        color: color[s] || '#666',
        border: `1px solid ${color[s] || '#666'}`,
        borderRadius: '4px',
        padding: '2px 8px',
        marginRight: '4px',
      }}
    >
      {s}
    </span>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: '#0f3460',
  color: '#e0e0e0',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: '#0a0a1a',
  color: '#e0e0e0',
  border: '1px solid #0f3460',
  borderRadius: '4px',
};

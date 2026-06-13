import { useStore } from '../state/store';

export function TelemetryDisplay() {
  // Real telemetry pushed from the backend via the 'telemetry' event.
  const telemetryMap = useStore((s) => s.telemetry);
  const receivers = useStore((s) => s.receivers);

  // Show a row per receiver; fall back to '--' until a frame arrives.
  const telemetry = receivers.map((r) => {
    const t = telemetryMap[r.id];
    return {
      receiver_id: r.id,
      label: r.label || r.url,
      s_meter_dbm: t?.s_meter_dbm,
      snr_db: t?.snr_db,
      status: t?.status,
    };
  });

  return (
    <div>
      <h2 style={{ marginBottom: '16px' }}>Telemetry</h2>
      
      {/* S-Meter visualization */}
      <div style={{ background: '#16213e', padding: '16px', borderRadius: '8px', border: '1px solid #0f3460', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', color: '#aaa', marginBottom: '12px' }}>S-Meter (dBm)</h3>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {telemetry.map(t => (
            <div key={t.receiver_id} style={{ flex: 1, minWidth: '200px' }}>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>{t.label}</div>
              <div style={{ height: '8px', background: '#0a0a1a', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, (t.s_meter_dbm || -90) + 90))}%`,
                  background: t.s_meter_dbm && t.s_meter_dbm > -60 ? '#e94560' : '#0f3460',
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <div style={{ fontSize: '12px', color: '#aaa', marginTop: '4px' }}>
                {t.s_meter_dbm?.toFixed(1) || '--'} dBm
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SNR table */}
      <div style={{ background: '#16213e', padding: '16px', borderRadius: '8px', border: '1px solid #0f3460' }}>
        <h3 style={{ fontSize: '14px', color: '#aaa', marginBottom: '12px' }}>Signal-to-Noise Ratio</h3>
        {telemetry.length === 0 ? (
          <div style={{ color: '#666', fontSize: '13px' }}>No telemetry data</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #0f3460' }}>
                <th style={thStyle}>Receiver</th>
                <th style={thStyle}>SNR (dB)</th>
                <th style={thStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {telemetry.map(t => (
                <tr key={t.receiver_id} style={{ borderBottom: '1px solid #0a0a1a' }}>
                  <td style={tdStyle}>{t.label}</td>
                  <td style={tdStyle}>{t.snr_db?.toFixed(1) ?? '--'}</td>
                  <td style={tdStyle}>{t.status ?? '--'}</td>
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

import { useEffect } from 'react';
import { ReceiverList } from './components/ReceiverList';
import { TranscriptPanel } from './components/TranscriptPanel';
import { TelemetryDisplay } from './components/TelemetryDisplay';
import { SettingsPanel } from './components/SettingsPanel';
import { useStore } from './state/store';

export default function App() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const initListeners = useStore((s) => s.initListeners);

  useEffect(() => {
    const un = initListeners();
    return () => {
      un.then((f) => f());
    };
  }, [initListeners]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <header style={{
        background: '#16213e',
        padding: '12px 24px',
        borderBottom: '1px solid #0f3460',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <h1 style={{ fontSize: '20px', fontWeight: 600, color: '#e94560' }}>HamHawk</h1>
        <nav style={{ display: 'flex', gap: '8px' }}>
          {['receivers', 'transcripts', 'telemetry', 'settings'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '6px 16px',
                background: activeTab === tab ? '#e94560' : 'transparent',
                color: activeTab === tab ? '#fff' : '#aaa',
                border: '1px solid #0f3460',
                borderRadius: '4px',
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {tab}
            </button>
          ))}
        </nav>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
        {activeTab === 'receivers' && <ReceiverList />}
        {activeTab === 'transcripts' && <TranscriptPanel />}
        {activeTab === 'telemetry' && <TelemetryDisplay />}
        {activeTab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  );
}

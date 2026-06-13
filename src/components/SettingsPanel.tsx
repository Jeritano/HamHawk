import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Settings {
  asr_worker_count: number;
  whisper_model_path?: string;
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>({ asr_worker_count: 2 });
  const [modelPath, setModelPath] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<Settings>('get_settings').then(setSettings).catch(console.error);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await invoke('set_settings', { settings: { ...settings, whisper_model_path: modelPath || undefined } });
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  };

  return (
    <div style={{ maxWidth: '600px' }}>
      <h2 style={{ marginBottom: '16px' }}>Settings</h2>

      <div style={{ background: '#16213e', padding: '16px', borderRadius: '8px', border: '1px solid #0f3460', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', color: '#aaa', marginBottom: '12px' }}>ASR</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <label style={{ color: '#e0e0e0', fontSize: '14px' }}>Worker Count:</label>
          <input
            type="number"
            min={1}
            max={8}
            value={settings.asr_worker_count}
            onChange={e => setSettings({ ...settings, asr_worker_count: Number(e.target.value) })}
            style={{ ...inputStyle, width: '80px' }}
          />
          <span style={{ color: '#666', fontSize: '12px' }}>workers for parallel transcription</span>
        </div>

        <div style={{ marginTop: '12px' }}>
          <label style={{ color: '#e0e0e0', fontSize: '14px', display: 'block', marginBottom: '4px' }}>Whisper Model Path:</label>
          <input
            placeholder="/path/to/ggml-base.bin"
            value={modelPath}
            onChange={e => setModelPath(e.target.value)}
            style={{ ...inputStyle, width: '100%' }}
          />
        </div>
      </div>

      <button onClick={handleSave} disabled={saving} style={btnStyle}>
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '8px 20px',
  background: '#e94560',
  color: '#fff',
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

import { useEffect } from "react";
import { useStore } from "./state/store";
import { Rig } from "./components/Rig";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { AddReceiverModal } from "./components/AddReceiverModal";
import { EditMemoryModal } from "./components/EditMemoryModal";

export default function App() {
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const loadAll = useStore((s) => s.loadAll);
  const initListeners = useStore((s) => s.initListeners);
  const error = useStore((s) => s.error);

  useEffect(() => {
    loadAll();
    const un = initListeners();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      un.then((f) => f());
    };
  }, [loadAll, initListeners, setPaletteOpen]);

  return (
    <>
      <Rig />
      {error && <div className="err-banner">{error}</div>}
      <CommandPalette />
      <SettingsModal />
      <AddReceiverModal />
      <EditMemoryModal />
      <Toasts />
    </>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.key), 6000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div className="toast" key={t.key} onClick={() => dismiss(t.key)}>
          <div className="rn">⚠ {t.ruleName}</div>
          <div>{t.text}</div>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useRef } from "react";
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
    let cancelled = false;
    const un = initListeners();
    // If unmount happens before the unlisten promise settles, still detach
    // every listener once it resolves so they don't leak across lifecycles.
    un.then((f) => {
      if (cancelled) f();
    });
    return () => {
      cancelled = true;
      un.then((f) => f());
    };
  }, [loadAll, initListeners]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen]);

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
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const live = timers.current;
    const keys = new Set(toasts.map((t) => t.key));
    // Start a 6s timer only for newly-added toasts; existing toasts keep
    // their original countdown so a new toast can't extend old ones.
    for (const t of toasts) {
      if (!live.has(t.key)) {
        live.set(
          t.key,
          setTimeout(() => dismiss(t.key), 6000),
        );
      }
    }
    // Drop timers for toasts that are already gone.
    for (const [key, id] of live) {
      if (!keys.has(key)) {
        clearTimeout(id);
        live.delete(key);
      }
    }
  }, [toasts, dismiss]);
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const id of live.values()) clearTimeout(id);
      live.clear();
    };
  }, []);
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

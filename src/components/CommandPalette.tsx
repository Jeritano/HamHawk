import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { formatFreq } from "../lib/format";

interface Cmd {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const receivers = useStore((s) => s.receivers);
  const bookmarks = useStore((s) => s.bookmarks);
  const setActive = useStore((s) => s.setActive);
  const setView = useStore((s) => s.setView);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setAddOpen = useStore((s) => s.setAddOpen);
  const applyBookmark = useStore((s) => s.applyBookmark);
  const setMonitor = useStore((s) => s.setMonitor);
  const activeId = useStore((s) => s.activeId);

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const close = () => setOpen(false);
    const list: Cmd[] = [
      { group: "View", label: "Workspace", run: () => { setView("workspace"); close(); } },
      { group: "View", label: "Matrix (all receivers)", run: () => { setView("matrix"); close(); } },
      { group: "Action", label: "Add receiver…", run: () => { setAddOpen(true); close(); } },
      { group: "Action", label: "Settings…", run: () => { setSettingsOpen(true); close(); } },
    ];
    if (activeId) list.push({ group: "Action", label: "Listen to active receiver", run: () => { setMonitor(activeId); close(); } });
    for (const r of receivers)
      list.push({ group: "Jump to receiver", label: r.label || r.url, hint: formatFreq(r.freq_hz), run: () => { setActive(r.id); close(); } });
    for (const b of bookmarks)
      list.push({ group: "Tune bookmark", label: b.label, hint: formatFreq(b.freq_hz), run: () => { applyBookmark(b); close(); } });
    return list;
  }, [receivers, bookmarks, activeId, setOpen, setView, setAddOpen, setSettingsOpen, setActive, applyBookmark, setMonitor]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => (c.label + " " + c.group).toLowerCase().includes(s));
  }, [q, commands]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => setSel(0), [q]);

  if (!open) return null;

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Search receivers, bookmarks, actions…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); filtered[sel]?.run(); }
            else if (e.key === "Escape") setOpen(false);
          }}
        />
        <div className="items">
          {filtered.length === 0 && <div className="grp">No matches</div>}
          {filtered.map((c, i) => {
            const showGrp = i === 0 || filtered[i - 1].group !== c.group;
            return (
              <div key={i}>
                {showGrp && <div className="grp">{c.group}</div>}
                <div className={"item" + (i === sel ? " sel" : "")} onMouseEnter={() => setSel(i)} onClick={() => c.run()}>
                  <span>{c.label}</span>
                  {c.hint && <span className="k">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

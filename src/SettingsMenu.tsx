import { useEffect, useRef, useState, type ReactNode } from "react";
import { Monitor, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { updateSettings, useSettings, type Settings, type Theme } from "./settings";

const THEMES: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor size={14} aria-hidden /> },
  { value: "light", label: "Light", icon: <Sun size={14} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={14} aria-hidden /> },
];

const TOGGLES: { key: keyof Settings; label: string; hint: string }[] = [
  { key: "minimap", label: "Mini map", hint: "Overview of the board in the corner" },
  { key: "grid", label: "Background dots", hint: "Dotted grid behind the canvas" },
  { key: "snap", label: "Snap to grid", hint: "Cards snap to 16 px steps while dragging" },
  { key: "stats", label: "Performance readout", hint: "FPS and object count" },
  { key: "cacheWebImages", label: "Keep web images", hint: "Save a copy in the board file, in case links die" },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`cn-switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function SettingsMenu() {
  const s = useSettings();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="cn-settings" ref={root}>
      <button
        className={`cn-icon-btn cn-gear${open ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Settings"
        aria-label="Settings"
      >
        <SettingsIcon size={17} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div className="cn-settings-panel" role="dialog" aria-label="Settings">
          <h3>Appearance</h3>
          <div className="cn-seg cn-theme" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.value}
                role="radio"
                aria-checked={s.theme === t.value}
                className={s.theme === t.value ? "on" : undefined}
                onClick={() => updateSettings({ theme: t.value })}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          <h3>Canvas</h3>
          <ul className="cn-toggles">
            {TOGGLES.map((t) => (
              <li key={t.key}>
                <div>
                  <span>{t.label}</span>
                  <small>{t.hint}</small>
                </div>
                <Switch
                  label={t.label}
                  checked={Boolean(s[t.key])}
                  onChange={(v) => updateSettings({ [t.key]: v })}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

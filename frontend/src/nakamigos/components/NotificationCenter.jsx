import { useState, useRef, useEffect, useCallback, memo } from "react";
import { createPortal } from "react-dom";

// ═══ CATEGORY CONFIG ═══
const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "price", label: "Price" },
  { key: "activity", label: "Activity" },
  { key: "whale", label: "Whale" },
];

const COOLDOWN_OPTIONS = [
  { value: 300000, label: "5 min" },
  { value: 900000, label: "15 min" },
  { value: 3600000, label: "1 hr" },
  { value: 86400000, label: "24 hr" },
];

const CATEGORY_ICONS = {
  price: "\u2193",
  activity: "\u26A1",
  whale: "\uD83D\uDC0B",
};

// ═══ BELL ICON BUTTON (exported for Header) ═══
export const NotificationBell = memo(function NotificationBell({ unreadCount, onClick }) {
  return (
    <button
      onClick={onClick}
      style={bellBtnStyle}
      aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      title="Notifications"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 01-3.46 0" />
      </svg>
      {unreadCount > 0 && (
        <span style={badgeStyle}>
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </button>
  );
});

// ═══ SETTINGS PANEL ═══
function AlertSettings({ config, updateConfig }) {
  const handleToggle = (type) => {
    updateConfig({
      [type]: { ...config[type], enabled: !config[type].enabled },
    });
  };

  const handleField = (type, field, value) => {
    updateConfig({
      [type]: { ...config[type], [field]: value },
    });
  };

  return (
    <div style={settingsContainerStyle}>
      <div style={settingsTitleStyle}>Alert Settings</div>

      {/* Floor Price */}
      <SettingRow
        label="Floor Price Alerts"
        enabled={config.floor.enabled}
        onToggle={() => handleToggle("floor")}
      >
        <SettingInput label="Drop %" value={config.floor.dropPercent} onChange={v => handleField("floor", "dropPercent", v)} min={1} max={100} />
        <SettingInput label="Rise %" value={config.floor.risePercent} onChange={v => handleField("floor", "risePercent", v)} min={1} max={100} />
      </SettingRow>

      {/* Underpriced */}
      <SettingRow
        label="Underpriced Listings"
        enabled={config.underpriced.enabled}
        onToggle={() => handleToggle("underpriced")}
      >
        <SettingInput label="Below floor %" value={config.underpriced.belowTraitFloorPercent} onChange={v => handleField("underpriced", "belowTraitFloorPercent", v)} min={5} max={90} />
      </SettingRow>

      {/* Whale */}
      <SettingRow
        label="Whale Activity"
        enabled={config.whale.enabled}
        onToggle={() => handleToggle("whale")}
      >
        <SettingInput label="Buy count" value={config.whale.buyCount} onChange={v => handleField("whale", "buyCount", v)} min={2} max={50} />
        <SettingInput label="Window (min)" value={config.whale.windowMinutes} onChange={v => handleField("whale", "windowMinutes", v)} min={1} max={60} />
      </SettingRow>

      {/* Volume Spike */}
      <SettingRow
        label="Volume Spike"
        enabled={config.volume.enabled}
        onToggle={() => handleToggle("volume")}
      >
        <SettingInput label="Spike multiplier" value={config.volume.spikeMultiplier} onChange={v => handleField("volume", "spikeMultiplier", v)} min={1.5} max={20} step={0.5} />
      </SettingRow>

      {/* Listing Rate */}
      <SettingRow
        label="Listing Rate Surge"
        enabled={config.listingRate.enabled}
        onToggle={() => handleToggle("listingRate")}
      >
        <SettingInput label="Count threshold" value={config.listingRate.count} onChange={v => handleField("listingRate", "count", v)} min={5} max={100} />
        <SettingInput label="Window (min)" value={config.listingRate.windowMinutes} onChange={v => handleField("listingRate", "windowMinutes", v)} min={10} max={120} />
        <SettingInput label="Normal rate" value={config.listingRate.normalRate} onChange={v => handleField("listingRate", "normalRate", v)} min={1} max={50} />
      </SettingRow>

      {/* Cooldown */}
      <div style={settingSectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={settingLabelStyle}>Cooldown Period</span>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {COOLDOWN_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => updateConfig({ cooldown: opt.value })}
              style={pillStyle(config.cooldown === opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Quiet Hours */}
      <div style={settingSectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <ToggleSwitch checked={config.quietHours.enabled} onChange={() => updateConfig({ quietHours: { ...config.quietHours, enabled: !config.quietHours.enabled } })} />
          <span style={settingLabelStyle}>Quiet Hours</span>
        </div>
        {config.quietHours.enabled && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <input
              type="time"
              value={config.quietHours.start}
              onChange={e => updateConfig({ quietHours: { ...config.quietHours, start: e.target.value } })}
              style={timeInputStyle}
            />
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>to</span>
            <input
              type="time"
              value={config.quietHours.end}
              onChange={e => updateConfig({ quietHours: { ...config.quietHours, end: e.target.value } })}
              style={timeInputStyle}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SettingRow({ label, enabled, onToggle, children }) {
  return (
    <div style={settingSectionStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: enabled ? 6 : 0 }}>
        <ToggleSwitch checked={enabled} onChange={onToggle} />
        <span style={{ ...settingLabelStyle, opacity: enabled ? 1 : 0.5 }}>{label}</span>
      </div>
      {enabled && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingLeft: 36 }}>{children}</div>}
    </div>
  );
}

function SettingInput({ label, value, onChange, min, max, step = 1 }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, fontFamily: "var(--pixel)", color: "var(--text-dim)", letterSpacing: "0.02em" }}>{label}</span>
      <input
        type="number"
        value={value}
        onChange={e => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
        min={min}
        max={max}
        step={step}
        style={numInputStyle}
      />
    </label>
  );
}

function ToggleSwitch({ checked, onChange }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      style={{
        width: 28,
        height: 16,
        borderRadius: 8,
        border: "none",
        background: checked ? "var(--green)" : "var(--border)",
        position: "relative",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "background 0.2s",
      }}
    >
      <span style={{
        position: "absolute",
        top: 2,
        left: checked ? 14 : 2,
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: "#fff",
        transition: "left 0.2s",
      }} />
    </button>
  );
}

// ═══ NOTIFICATION ITEM ═══
function NotificationItem({ notification, onRead, onRemove }) {
  const timeAgo = formatTimeAgo(notification.timestamp);
  const icon = CATEGORY_ICONS[notification.category] || "\uD83D\uDD14";

  return (
    <div
      style={{
        ...notifItemStyle,
        opacity: notification.read ? 0.6 : 1,
        borderLeft: notification.read ? "3px solid transparent" : "3px solid var(--naka-blue)",
      }}
      onClick={() => !notification.read && onRead(notification.id)}
    >
      <div style={{ fontSize: 16, lineHeight: 1, flexShrink: 0, width: 20, textAlign: "center" }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--display)", fontSize: 12, fontWeight: 600, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {notification.title}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.3 }}>
          {notification.body}
        </div>
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3, fontFamily: "var(--mono)" }}>
          {timeAgo}{notification.collection ? ` \u00b7 ${notification.collection}` : ""}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(notification.id); }}
        style={removeNotifBtnStyle}
        title="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}

// ═══ MAIN COMPONENT ═══
export default memo(function NotificationCenter({
  config,
  updateConfig,
  history,
  unreadCount,
  markRead,
  markAllRead,
  clearHistory,
  removeNotification,
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [showSettings, setShowSettings] = useState(false);
  const panelRef = useRef(null);
  const bellRef = useRef(null);
  const [panelPos, setPanelPos] = useState({ top: 44, right: 16 });

  const toggleOpen = useCallback(() => {
    setOpen(prev => {
      if (!prev && bellRef.current) {
        const r = bellRef.current.getBoundingClientRect();
        setPanelPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right - 40) });
      }
      return !prev;
    });
    setShowSettings(false);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        bellRef.current && !bellRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const filtered = activeTab === "all"
    ? history
    : history.filter(n => n.category === activeTab);

  return (
    <>
      <div ref={bellRef}>
        <NotificationBell unreadCount={unreadCount} onClick={toggleOpen} />
      </div>

      {open && createPortal(
        <>
          {/* Backdrop */}
          <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={() => setOpen(false)} />

          {/* Panel */}
          <div ref={panelRef} style={{ ...panelStyle, top: panelPos.top, right: panelPos.right }}>
            {/* Header */}
            <div style={panelHeaderStyle}>
              <span style={{ fontFamily: "var(--display)", fontSize: 14, fontWeight: 700 }}>
                {showSettings ? "Alert Settings" : "Notifications"}
              </span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {!showSettings && unreadCount > 0 && (
                  <button onClick={markAllRead} style={actionBtnStyle} title="Mark all as read">
                    Mark read
                  </button>
                )}
                {!showSettings && history.length > 0 && (
                  <button onClick={clearHistory} style={actionBtnStyle} title="Clear all">
                    Clear
                  </button>
                )}
                <button
                  onClick={() => setShowSettings(p => !p)}
                  style={{ ...actionBtnStyle, color: showSettings ? "var(--gold)" : undefined }}
                  title={showSettings ? "Back to notifications" : "Settings"}
                >
                  {showSettings ? "Back" : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {showSettings ? (
              <AlertSettings config={config} updateConfig={updateConfig} />
            ) : (
              <>
                {/* Category Tabs */}
                <div style={tabBarStyle}>
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.key}
                      onClick={() => setActiveTab(cat.key)}
                      style={tabBtnStyle(activeTab === cat.key)}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>

                {/* Notification List */}
                <div style={listContainerStyle}>
                  {filtered.length === 0 ? (
                    <div style={emptyStyle}>
                      <div style={{ fontSize: 24, marginBottom: 8 }}>{"\uD83D\uDD14"}</div>
                      <div>No notifications{activeTab !== "all" ? ` in ${activeTab}` : ""}</div>
                    </div>
                  ) : (
                    filtered.map(n => (
                      <NotificationItem
                        key={n.id}
                        notification={n}
                        onRead={markRead}
                        onRemove={removeNotification}
                      />
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </>,
        document.body
      )}
    </>
  );
});

// ═══ HELPERS ═══
function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 0) return "now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ═══ STYLES ═══
const bellBtnStyle = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 34,
  height: 34,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface-glass)",
  backdropFilter: "var(--glass-blur)",
  color: "var(--text)",
  cursor: "pointer",
  transition: "border-color 0.2s, background 0.2s",
  padding: 0,
};

const badgeStyle = {
  position: "absolute",
  top: -5,
  right: -5,
  minWidth: 16,
  height: 16,
  borderRadius: 8,
  background: "var(--red, #ef4444)",
  color: "#fff",
  fontFamily: "var(--mono)",
  fontSize: 9,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 4px",
  lineHeight: 1,
  boxShadow: "0 0 6px var(--red, #ef4444)",
};

const panelStyle = {
  position: "fixed",
  zIndex: 9999,
  width: 380,
  maxWidth: "calc(100vw - 16px)",
  maxHeight: "calc(100vh - 80px)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const panelHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const actionBtnStyle = {
  background: "none",
  border: "none",
  color: "var(--text-dim)",
  fontFamily: "var(--pixel)",
  fontSize: 9,
  cursor: "pointer",
  padding: "4px 6px",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  gap: 4,
  transition: "color 0.2s",
};

const tabBarStyle = {
  display: "flex",
  gap: 0,
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const tabBtnStyle = (active) => ({
  flex: 1,
  padding: "8px 0",
  background: "none",
  border: "none",
  borderBottom: active ? "2px solid var(--gold)" : "2px solid transparent",
  color: active ? "var(--gold)" : "var(--text-dim)",
  fontFamily: "var(--pixel)",
  fontSize: 9,
  cursor: "pointer",
  transition: "color 0.2s, border-color 0.2s",
});

const listContainerStyle = {
  flex: 1,
  overflowY: "auto",
  maxHeight: 420,
};

const notifItemStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  cursor: "pointer",
  transition: "background 0.15s",
};

const removeNotifBtnStyle = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  padding: "2px 4px",
  fontSize: 16,
  lineHeight: 1,
  flexShrink: 0,
  fontFamily: "var(--mono)",
  opacity: 0.5,
};

const emptyStyle = {
  textAlign: "center",
  padding: "40px 16px",
  fontFamily: "var(--pixel)",
  fontSize: 11,
  color: "var(--text-dim)",
};

const settingsContainerStyle = {
  padding: "10px 14px",
  overflowY: "auto",
  maxHeight: 420,
};

const settingsTitleStyle = {
  fontFamily: "var(--pixel)",
  fontSize: 10,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 10,
};

const settingSectionStyle = {
  marginBottom: 12,
  padding: "8px 0",
  borderBottom: "1px solid var(--border)",
};

const settingLabelStyle = {
  fontFamily: "var(--display)",
  fontSize: 12,
  fontWeight: 600,
};

const numInputStyle = {
  width: 60,
  padding: "3px 6px",
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "inherit",
  fontFamily: "var(--mono)",
  fontSize: 11,
  outline: "none",
};

const timeInputStyle = {
  padding: "3px 6px",
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "inherit",
  fontFamily: "var(--mono)",
  fontSize: 11,
  outline: "none",
};

const pillStyle = (active) => ({
  padding: "4px 10px",
  borderRadius: 12,
  border: "1px solid " + (active ? "var(--gold)" : "var(--border)"),
  background: active ? "var(--gold)" : "var(--card)",
  color: active ? "#000" : "var(--text-dim)",
  fontFamily: "var(--pixel)",
  fontSize: 9,
  cursor: "pointer",
  transition: "all 0.2s",
});

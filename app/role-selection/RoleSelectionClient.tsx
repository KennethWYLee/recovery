"use client";

import { useEffect, useMemo, useState } from "react";

type SelectableRole = "commander" | "responder" | "observer" | "auditor";

type RoleSelectionState = {
  selectionRequired: boolean;
  managedRole: boolean;
  currentRole: "admin" | SelectableRole;
  membershipVersion: number | null;
  options: Array<{ role: SelectableRole; available: boolean }>;
};

type ApiEnvelope<T> = {
  data?: T;
  error?: { message?: string };
  detail?: string;
  message?: string;
};

const ROLE_DETAILS: Record<SelectableRole, { label: string; summary: string; scope: string }> = {
  commander: {
    label: "事件指揮者",
    summary: "建立事件與服務，協調事件處理。",
    scope: "高風險操作仍需取得該事件的指揮角色。",
  },
  responder: {
    label: "應變人員",
    summary: "調查事件、執行處置並留下驗證紀錄。",
    scope: "只能修改自己已被指派的事件。",
  },
  observer: {
    label: "觀察者",
    summary: "查閱事件、服務與營運狀態。",
    scope: "唯讀；不能新增、修改、指派、發布或刪除資料。",
  },
  auditor: {
    label: "稽核人員",
    summary: "查閱事件、服務、稽核紀錄與權限政策。",
    scope: "唯讀；稽核畫面不顯示操作者 Email。",
  },
};

async function responseData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.message ?? payload?.detail ?? payload?.message ?? "目前無法完成角色選擇。");
  }
  return payload.data;
}

export function RoleSelectionClient({
  identity,
  signOutPath,
}: {
  identity: { displayName: string; email: string };
  signOutPath: string;
}) {
  const [state, setState] = useState<RoleSelectionState | null>(null);
  const [selectedRole, setSelectedRole] = useState<SelectableRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/session/role", { cache: "no-store", headers: { accept: "application/json" } })
      .then((response) => responseData<RoleSelectionState>(response))
      .then((next) => {
        if (!active) return;
        setState(next);
        const current = next.options.find((option) => option.role === next.currentRole && option.available);
        setSelectedRole(current?.role ?? next.options.find((option) => option.available)?.role ?? null);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "目前無法取得角色選項。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const enabledRoles = useMemo(() => new Set(
    state?.options.filter((option) => option.available).map((option) => option.role) ?? [],
  ), [state]);

  async function submitRole() {
    if (!state || state.membershipVersion === null || !selectedRole || !enabledRoles.has(selectedRole)) return;
    setSaving(true);
    setError(null);
    try {
      await responseData(await fetch("/api/v1/session/role", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": `role-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ role: selectedRole, expectedVersion: state.membershipVersion }),
      }));
      window.location.assign("/operations");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "目前無法套用角色。");
      setSaving(false);
    }
  }

  return (
    <main className="role-selection-page">
      <section className="role-selection-shell" aria-labelledby="role-selection-title">
        <header className="role-selection-header">
          <div className="product-mark" aria-hidden="true">CO</div>
          <div>
            <p className="eyebrow">CONTINUITY OPS</p>
            <h1 id="role-selection-title">選擇本次使用身分</h1>
            <p>角色會同時決定可見畫面與伺服器允許的操作。下次重新登入時可以再次選擇。</p>
          </div>
          <div className="role-selection-identity">
            <strong>{identity.displayName}</strong>
            <span>{identity.email}</span>
            <a href={signOutPath}>改用其他帳號</a>
          </div>
        </header>

        {loading ? (
          <div className="role-selection-status" role="status"><span className="spinner" />正在取得可用角色…</div>
        ) : error && !state ? (
          <div className="role-selection-error" role="alert"><strong>無法載入角色</strong><span>{error}</span><button className="button secondary" type="button" onClick={() => window.location.reload()}>重新載入</button></div>
        ) : state?.managedRole ? (
          <div className="managed-role-card">
            <span className="managed-role-badge">系統指定</span>
            <h2>{state.currentRole === "admin" ? "系統管理員" : "既有授權角色"}</h2>
            <p>{state.currentRole === "admin" ? "系統管理員不能由登入者自行選取或變更。" : "此帳號的角色由管理員設定，不使用校內帳號自選流程。"}</p>
            <button className="button primary" type="button" onClick={() => window.location.assign("/operations")}>進入事件指揮中心</button>
          </div>
        ) : (
          <>
            <fieldset className="role-options" disabled={saving}>
              <legend className="sr-only">選擇角色</legend>
              {state?.options.map((option) => {
                const detail = ROLE_DETAILS[option.role];
                const selected = selectedRole === option.role;
                return (
                  <label key={option.role} className={`role-option ${selected ? "selected" : ""} ${option.available ? "" : "unavailable"}`}>
                    <input
                      type="radio"
                      name="role"
                      value={option.role}
                      checked={selected}
                      disabled={!option.available}
                      onChange={() => setSelectedRole(option.role)}
                    />
                    <span className="role-option-marker" aria-hidden="true" />
                    <span className="role-option-copy">
                      <strong>{detail.label}</strong>
                      <span>{detail.summary}</span>
                      <small>{option.available ? detail.scope : "目前仍有與此角色不相容的事件責任，請先完成交接。"}</small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {error && <div className="role-selection-error compact" role="alert">{error}</div>}
            <footer className="role-selection-actions">
              <p>系統管理員由部署設定或既有管理權限指定，不會出現在選項中。</p>
              <button className="button primary" type="button" disabled={!selectedRole || saving} onClick={() => void submitRole()}>
                {saving ? "正在套用…" : "使用此身分進入"}
              </button>
            </footer>
          </>
        )}
      </section>
    </main>
  );
}

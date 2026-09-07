"use client";

import Link from "next/link";
import { Copy, LogOut } from "lucide-react";
import { useState } from "react";
import { CourseJoinQrButton } from "../CourseJoinQrButton";

export function CourseJoinHelp() {
  const [code, setCode] = useState("");
  const valid = /^[23456789A-HJ-NP-Z]{6}$/u.test(code);
  return <form className="course-load-join" onSubmit={(event) => { event.preventDefault(); if (valid) window.location.assign(`/join/${encodeURIComponent(code)}`); }}>
    <strong>輸入課程代碼加入</strong>
    <p>若你已登入但尚未報到，請輸入教師提供的課堂代碼加入。</p>
    <label>六位課堂代碼<input value={code} maxLength={6} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="例如 A7K2M6" onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/gu, ""))} /></label>
    <button type="submit" className="button primary" disabled={!valid}>加入課堂</button>
    <Link href="/courses">回課程首頁</Link>
  </form>;
}

export function CourseWorkspaceHeader({ displayName, roleLabel, signOutPath, joinCode }: {
  displayName: string; roleLabel: string; signOutPath: string; joinCode?: string;
}) {
  const [copyMessage, setCopyMessage] = useState("");
  async function copyCode() {
    if (!joinCode) return;
    try {
      await navigator.clipboard.writeText(joinCode);
      setCopyMessage("已複製");
    } catch {
      setCopyMessage("無法複製，請直接選取代碼。");
    }
  }
  return <header className="course-topbar workspace-topbar">
    <Link href="/courses" className="course-brand">
      <span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong>
    </Link>
    {joinCode && <div className="workspace-code" aria-label="本次課堂代碼">
      <span>課堂代碼</span>
      <strong className="workspace-code-value">{joinCode}</strong>
      <button type="button" className="button secondary" onClick={() => void copyCode()} aria-label={`複製課堂代碼 ${joinCode}`}><Copy />複製</button>
      <CourseJoinQrButton joinCode={joinCode} />
      <span className="workspace-code-message" role="status">{copyMessage}</span>
    </div>}
    <div className="course-account">
      <span><strong>{displayName}</strong><small>{roleLabel}</small></span>
      <a href={signOutPath}><LogOut />登出</a>
    </div>
  </header>;
}

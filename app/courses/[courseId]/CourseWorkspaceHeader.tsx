"use client";

import Link from "next/link";
import { Copy, LogOut } from "lucide-react";
import { useState } from "react";

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
      <span className="workspace-code-message" role="status">{copyMessage}</span>
    </div>}
    <div className="course-account">
      <span><strong>{displayName}</strong><small>{roleLabel}</small></span>
      <a href={signOutPath}><LogOut />登出</a>
    </div>
  </header>;
}

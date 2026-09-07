"use client";

import { QrCode, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useId, useRef, useState } from "react";
import { classroomApiData } from "@/lib/classroom-api-client";
import type { ClassroomSessionSnapshot } from "@/lib/classroom-domain";

export function CourseJoinQrButton({ courseId, courseName, joinCode }: { courseId?: string; courseName?: string; joinCode?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function openQr() {
    setError(""); setCode(""); setUrl(""); setPending(true);
    dialogRef.current?.showModal();
    try {
      let currentCode = joinCode;
      if (!currentCode && courseId) {
        const data = await classroomApiData<{ snapshot: ClassroomSessionSnapshot | null }>(await fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}/session`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }));
        if (!data.snapshot?.session.admissionOpen) throw new Error("本次課堂目前未開放加入，請進入課堂確認設定。");
        currentCode = data.snapshot.session.joinCode;
      }
      if (!currentCode) throw new Error("目前沒有可加入的課堂，請先進入課程建立今日課堂。");
      setCode(currentCode);
      setUrl(`${window.location.origin}/join/${encodeURIComponent(currentCode)}`);
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "取得課堂代碼逾時，請關閉後重試。");
    } finally { setPending(false); }
  }
  return <>
    <button type="button" className="button secondary course-qr-button" aria-label={`顯示${courseName ?? "本次課堂"}的 QR code`} title="顯示加入課堂 QR code" disabled={pending} onClick={() => void openQr()}><QrCode />QR code</button>
    <dialog ref={dialogRef} className="course-dialog course-qr-dialog" aria-labelledby={titleId}>
      <header><div><h2 id={titleId}>{courseName ?? "加入本次課堂"}</h2><p>學生掃描後登入，即可加入課堂。</p></div><button type="button" className="course-icon-button" aria-label="關閉 QR code" onClick={() => dialogRef.current?.close()}><X /></button></header>
      {pending ? <p role="status">正在取得課堂代碼…</p> : error ? <p role="alert">{error}</p> : <div className="course-qr-image">
        {url && <QRCodeSVG value={url} size={288} level="M" marginSize={4} title="加入本次課堂 QR code" />}
        <span>也可輸入課堂代碼</span><strong>{code}</strong>
      </div>}
    </dialog>
  </>;
}

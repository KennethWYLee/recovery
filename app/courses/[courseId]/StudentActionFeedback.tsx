"use client";

import { useEffect, useRef } from "react";

export function StudentActionFeedback({ error, notice }: { error: string | null; notice: string | null }) {
  const feedbackRef = useRef<HTMLDivElement>(null);
  const message = error ?? notice;
  useEffect(() => {
    if (message) {
      feedbackRef.current?.focus({ preventScroll: true });
      feedbackRef.current?.scrollIntoView({ block: "center" });
    }
  }, [message]);
  if (!message) return null;
  return <div ref={feedbackRef} tabIndex={-1} className={`workspace-alert ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>
    <strong>{error ? "操作未完成" : "伺服器已確認"}</strong>
    <span>{message}</span>
  </div>;
}

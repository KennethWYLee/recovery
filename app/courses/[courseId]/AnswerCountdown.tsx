"use client";

import { memo, useEffect, useState } from "react";

export const AnswerCountdown = memo(function AnswerCountdown({ deadline, serverNow }: { deadline: string | null; serverNow: string }) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!deadline) return;
    const offset = Date.parse(serverNow) - Date.now();
    const update = () => setRemaining(Math.max(0, Math.ceil((Date.parse(deadline) - Date.now() - offset) / 1_000)));
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [deadline, serverNow]);
  const seconds = deadline ? remaining : null;
  return <time className={seconds !== null && seconds <= 60 ? "urgent" : ""}>
    {seconds === null ? "等待教師開始計時" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
  </time>;
});

"use client";

import { CourseJoinHelp } from "./CourseWorkspaceHeader";

export function CourseWorkspaceLoadState({ error, draftText, draftDirty, courseId, hosted, onRetry }: {
  error: string; draftText: string; draftDirty: boolean; courseId: string; hosted: boolean; onRetry: () => void;
}) {
  return <div className="course-shell">
    <main className="course-workspace-main">
      {error ? <div className="courses-error" role="alert">
        <strong>無法開啟課程</strong>
        <span>{error}</span>
        {draftDirty && <label className="course-field">
          <span>尚未儲存的回答，離開或重新登入前請先複製</span>
          <textarea readOnly value={draftText} rows={4} />
        </label>}
        {hosted && <a href={`/signin-with-chatgpt?return_to=${encodeURIComponent(`/courses/${courseId}`)}`} target="_top">重新登入</a>}
        <button className="button secondary" onClick={onRetry}>重新載入</button>
        <CourseJoinHelp />
      </div> : <div className="courses-loading">
        <span className="spinner" />正在開啟課程…
      </div>}
    </main>
  </div>;
}

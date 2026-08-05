import type { Metadata } from "next";
import Link from "next/link";
import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { classroomPageIdentity } from "../classroom-page-identity";
import { CourseWorkspace } from "./CourseWorkspace";

export const metadata: Metadata = { title: "課程" };
export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const returnTo = `/courses/${encodeURIComponent(courseId)}`;
  const identity = await classroomPageIdentity(returnTo);
  if (!identity) {
    return <main className="classroom-auth-page"><section className="classroom-auth-card"><h1>請先登入</h1><p>完成校內帳號驗證後，系統會帶您回到這門課程。</p><Link className="button primary wide" href={chatGPTSignInPath(returnTo)}>使用校內帳號登入</Link></section></main>;
  }
  return <CourseWorkspace courseId={courseId} identity={identity} />;
}

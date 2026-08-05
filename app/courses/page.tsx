import type { Metadata } from "next";
import Link from "next/link";
import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { classroomPageIdentity } from "./classroom-page-identity";
import { CoursesApp } from "./CoursesApp";

export const metadata: Metadata = { title: "我的課程" };
export const dynamic = "force-dynamic";

export default async function CoursesPage() {
  const identity = await classroomPageIdentity("/courses");
  if (!identity) {
    return <main className="classroom-auth-page"><section className="classroom-auth-card" aria-labelledby="classroom-auth-title">
      <div className="classroom-brand-mark" aria-hidden="true">課</div>
      <p className="classroom-kicker">課堂小組回應與排序系統</p>
      <h1 id="classroom-auth-title">進入您的課程</h1>
      <p>教師可以建立課堂活動，學生掃描當天的QR Code後會直接進入指定課程。</p>
      <Link className="button primary wide" href={chatGPTSignInPath("/courses")}>使用校內帳號登入</Link>
      <small>學生資料與個人排序不會顯示於課堂投影畫面。</small>
    </section></main>;
  }
  return <CoursesApp identity={identity} />;
}

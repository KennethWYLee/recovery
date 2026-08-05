import type { Metadata } from "next";
import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { classroomPageIdentity } from "@/app/courses/classroom-page-identity";
import { JoinSessionApp } from "./JoinSessionApp";

export const metadata: Metadata = { title: "加入今日課堂" };
export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: { params: Promise<{ joinCode: string }> }) {
  const { joinCode } = await params;
  const returnTo = `/join/${encodeURIComponent(joinCode)}`;
  const identity = await classroomPageIdentity(returnTo);
  if (!identity) {
    return <main className="classroom-auth-page"><section className="classroom-auth-card">
      <div className="classroom-brand-mark" aria-hidden="true">課</div>
      <p className="classroom-kicker">加入今日課堂</p>
      <h1>先驗證您的校內帳號</h1>
      <p>登入後會直接回到這次課堂；新帳號需等待系統管理員核准。</p>
      <a className="button primary wide" href={chatGPTSignInPath(returnTo)}>使用 @ntub.edu.tw 帳號登入</a>
    </section></main>;
  }
  return <JoinSessionApp joinCode={joinCode} identity={identity} />;
}

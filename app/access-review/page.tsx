import type { Metadata } from "next";
import Link from "next/link";
import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { classroomPageIdentity } from "@/app/courses/classroom-page-identity";
import { AccessReviewApp } from "./AccessReviewApp";

export const metadata: Metadata = { title: "登入審核" };
export const dynamic = "force-dynamic";

export default async function AccessReviewPage() {
  const identity = await classroomPageIdentity("/access-review");
  if (!identity) {
    return <main className="classroom-auth-page"><section className="classroom-auth-card"><div className="classroom-brand-mark" aria-hidden="true">課</div><p className="classroom-kicker">系統管理</p><h1>請先登入</h1><p>系統管理員登入後，才能審核帳號使用申請。</p><Link className="button primary wide" href={chatGPTSignInPath("/access-review")}>登入系統</Link></section></main>;
  }
  return <AccessReviewApp identity={identity} />;
}

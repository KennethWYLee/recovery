import type { Metadata } from "next";
import Link from "next/link";
import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { classroomPageIdentity } from "@/app/courses/classroom-page-identity";
import { ObservabilityApp } from "./ObservabilityApp";

export const metadata: Metadata = { title: "營運紀錄與問題追蹤" };
export const dynamic = "force-dynamic";

export default async function ObservabilityPage() {
  const identity = await classroomPageIdentity("/observability");
  if (!identity) {
    return <main className="classroom-auth-page"><section className="classroom-auth-card" aria-labelledby="observability-auth-title">
      <div className="classroom-brand-mark" aria-hidden="true">課</div>
      <p className="classroom-kicker">系統管理</p>
      <h1 id="observability-auth-title">請先登入</h1>
      <p>系統管理員登入後，才能查看營運紀錄與問題追蹤資料。</p>
      <Link className="button primary wide" href={chatGPTSignInPath("/observability")}>登入系統</Link>
    </section></main>;
  }
  return <ObservabilityApp identity={identity} />;
}

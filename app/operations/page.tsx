import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { operationsEnvironment } from "@/db/operations";
import { roleSelectionUrl } from "@/lib/public-site-url";
import { SIGN_IN_QR_APPEARANCE } from "@/lib/sign-in-qr";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "@/app/chatgpt-auth";
import { OperationsApp, type InitialIdentity } from "./OperationsApp";

export const metadata: Metadata = {
  title: "Operations",
};

export const dynamic = "force-dynamic";

function isLocalRequest(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function localIdentity(host: string): InitialIdentity | null {
  if (!isLocalRequest(host)) return null;

  const environment = operationsEnvironment();
  const email = environment.CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL?.trim();
  const displayName = environment.CONTINUITY_OPS_LOCAL_OPERATOR_NAME?.trim();
  if (!email || !displayName) return null;

  return {
    displayName,
    email,
    mode: "local",
    signOutPath: "/operations",
  };
}

export default async function OperationsPage() {
  const requestHeaders = await headers();
  const environment = operationsEnvironment();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "")
    .split(",")[0]
    .trim();
  const hostedUser = await getChatGPTUser();
  const identity: InitialIdentity | null = hostedUser
    ? {
        displayName: hostedUser.displayName,
        email: hostedUser.email,
        mode: "hosted",
        signOutPath: chatGPTSignOutPath("/operations"),
      }
    : localIdentity(host);

  if (!identity) {
    const local = isLocalRequest(host);
    const roleSelectionEntryUrl = roleSelectionUrl({
      configuredOrigin: environment.CONTINUITY_OPS_PUBLIC_ORIGIN,
      forwardedHost: requestHeaders.get("x-forwarded-host"),
      host: requestHeaders.get("host"),
      forwardedProtocol: requestHeaders.get("x-forwarded-proto"),
    });
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="product-mark" aria-hidden="true">CO</div>
          <p className="eyebrow">CONTINUITY OPS</p>
          <h1 id="auth-title">使用組織身分進入事件指揮中心</h1>
          <p>
            @ntub.edu.tw 校內信箱登入後可選擇非管理員角色；系統管理員由既有授權或部署設定指定。
          </p>
          {local ? (
            <div className="auth-guidance" role="status">
              本機環境尚未設定開發身分。請設定
              <code>CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL</code> 與
              <code>CONTINUITY_OPS_LOCAL_OPERATOR_NAME</code> 後重新啟動服務。
            </div>
          ) : (
            <div className="auth-entry-grid">
              <section className="auth-device-option" aria-labelledby="device-sign-in-title">
                <span className="auth-option-label">此裝置</span>
                <h2 id="device-sign-in-title">在目前裝置登入</h2>
                <p>完成組織身分驗證後，選擇本次使用角色。</p>
                <Link className="button primary wide" href={chatGPTSignInPath("/role-selection")}>以組織身分登入</Link>
              </section>
              {roleSelectionEntryUrl && (
                <>
                  <div className="auth-method-divider" aria-hidden="true"><span>或</span></div>
                  <figure className="auth-qr-option">
                    <div className="auth-qr-frame">
                      <QRCodeSVG
                        {...SIGN_IN_QR_APPEARANCE}
                        value={roleSelectionEntryUrl}
                        title="Continuity Ops 手機登入 QR Code"
                      />
                    </div>
                    <figcaption>
                      <strong>使用手機登入</strong>
                      <span>以相機掃描後，在手機完成相同的身分驗證。</span>
                    </figcaption>
                  </figure>
                </>
              )}
            </div>
          )}
          <small>所有寫入操作都會在伺服器端重新驗證權限並留下稽核紀錄。</small>
        </section>
      </main>
    );
  }

  return <OperationsApp initialIdentity={identity} />;
}

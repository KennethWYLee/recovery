import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "driver.js/dist/driver.css";
import "./globals.css";

function metadataForBase(metadataBase: URL): Metadata {
  return {
    metadataBase,
    title: {
      default: "課堂小組回應與排序系統",
      template: "%s | 課堂小組回應與排序系統",
    },
    description: "支援課堂小組回答、完整同儕排序與全班結果彙整。",
    applicationName: "課堂小組回應與排序系統",
    openGraph: {
      type: "website",
      title: "課堂小組回應與排序系統",
      description: "從小組討論到全班完整排序，讓每一份想法都能被看見。",
      images: [
        {
          url: "/og-classroom.png",
          width: 1672,
          height: 941,
          alt: "課堂小組回應與排序系統",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "課堂小組回應與排序系統",
      description: "從小組討論到全班完整排序。",
      images: ["/og-classroom.png"],
    },
    robots: { index: false, follow: false },
  };
}

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host")?.trim();
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : "https";
  try {
    return metadataForBase(host ? new URL(`${protocol}://${host}`) : new URL("http://localhost:3000"));
  } catch {
    return metadataForBase(new URL("http://localhost:3000"));
  }
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#111827",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

function metadataForBase(metadataBase: URL): Metadata {
  return {
    metadataBase,
    title: {
      default: "Continuity Ops",
      template: "%s | Continuity Ops",
    },
    description: "Incident command, evidence-led recovery, and operational assurance for professional response teams.",
    applicationName: "Continuity Ops",
    openGraph: {
      type: "website",
      title: "Continuity Ops",
      description: "Command. Verify. Recover.",
      images: [
        {
          url: "/og.png",
          width: 1672,
          height: 941,
          alt: "Continuity Ops incident command, verification, and recovery workflow",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Continuity Ops",
      description: "Command. Verify. Recover.",
      images: ["/og.png"],
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

import type { Metadata } from "next";
import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { RoleSelectionClient } from "./RoleSelectionClient";

export const metadata: Metadata = {
  title: "Select role",
};

export const dynamic = "force-dynamic";

export default async function RoleSelectionPage() {
  const user = await requireChatGPTUser("/role-selection");
  return (
    <RoleSelectionClient
      identity={{ displayName: user.displayName, email: user.email }}
      signOutPath={chatGPTSignOutPath("/operations")}
    />
  );
}

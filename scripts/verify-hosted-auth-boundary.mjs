const publicUrl = process.env.CLASSROOM_PUBLIC_URL?.trim();
if (!publicUrl) {
  console.error("CLASSROOM_PUBLIC_URL is required for the hosted authentication boundary check.");
  process.exitCode = 2;
} else {
  const endpoint = new URL("/api/classroom/courses", publicUrl);
  const response = await fetch(endpoint, {
    redirect: "manual",
    headers: {
      "oai-authenticated-user-email": "wy.lee@ntub.edu.tw",
      "oai-authenticated-user-id": "forged-boundary-check",
      "oai-authenticated-user-full-name": "Forged Administrator",
    },
  });
  if (response.status !== 401 && response.status !== 403) {
    console.error(`Hosted identity boundary failed: forged headers received HTTP ${response.status}.`);
    process.exitCode = 1;
  } else {
    console.log(`Hosted identity boundary passed: forged headers were rejected with HTTP ${response.status}.`);
  }
}

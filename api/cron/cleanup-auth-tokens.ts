import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runCleanupAuthTokensJob } from "../../server/jobs/cleanup-auth-tokens.job.js";

export const config = {
  runtime: "nodejs",
  maxDuration: 60
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  // Vercel Cron invokes the function with GET. POST is also accepted for
  // controlled manual invocation from trusted automation.
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  const cronSecret = process.env.CRON_SECRET;
  const expectedAuthorization = cronSecret ? `Bearer ${cronSecret}` : "";

  if (!cronSecret || req.headers.authorization !== expectedAuthorization) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  try {
    const deleted = await runCleanupAuthTokensJob();
    return res.status(200).json({ success: true, deleted });
  } catch (error) {
    console.error("[AuthTokenCleanup] Scheduled cleanup failed:", error);
    return res.status(500).json({ error: "AUTH_TOKEN_CLEANUP_FAILED" });
  }
}

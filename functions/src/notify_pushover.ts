import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";

// Secrets: set with `firebase functions:secrets:set PUSHOVER_USER` and `PUSHOVER_TOKEN`
const PUSHOVER_USER = defineSecret("PUSHOVER_USER");
const PUSHOVER_TOKEN = defineSecret("PUSHOVER_TOKEN");

/**
 * Fires when a user joins the queue and sends a Pushover notification.
 * Document path: match_queue/{userId}
 */
export const notifyPushoverOnQueueJoin = onDocumentCreated(
  {
    document: "match_queue/{userId}",
    secrets: [PUSHOVER_USER, PUSHOVER_TOKEN],
  },
  async (event) => {
    const doc = event.data;
    const userId = event.params.userId;
    // ignore my own user
    if (userId == "73FowSCaUxXJBKb1xw6uqo3zCvq1") return;
    if (!doc) {
      console.log("No document data available for Pushover notification");
      return;
    }

    const data = (doc.data() as { username?: string | null }) || {};

    const userKey = PUSHOVER_USER.value();
    const apiToken = PUSHOVER_TOKEN.value();

    if (!userKey || !apiToken) {
      console.warn(
        "Pushover credentials not configured (PUSHOVER_USER/PUSHOVER_TOKEN). Skipping notification."
      );
      return;
    }

    const title = "Turnix: New player in queue";
    const message = `${data.username ?? userId} joined the match queue`;

    try {
      const response = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: apiToken,
          user: userKey,
          title,
          message,
          priority: "0",
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "<no-body>");
        console.error(`Pushover API error (${response.status}): ${text}`);
        return;
      }

      console.log(`Pushover notification sent for user ${userId}`);
    } catch (err) {
      console.error("Failed to send Pushover notification:", err);
    }
  }
);

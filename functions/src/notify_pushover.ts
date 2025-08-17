import * as admin from "firebase-admin";
import { BaseMessage } from "firebase-admin/lib/messaging/messaging-api";
import { onDocumentCreated } from "firebase-functions/v2/firestore";

const db = admin.firestore();

/**
 * Fires when a user joins the queue and sends FCM notifications to all other users.
 * Document path: match_queue/{userId}
 */
export const notifyUsersOnQueueJoin = onDocumentCreated(
  "match_queue/{userId}",
  async (event) => {
    const doc = event.data;
    const userId = event.params.userId;

    if (!doc) {
      console.log("No document data available for FCM notification");
      return;
    }

    const data =
      (doc.data() as {
        username?: string | null;
        avatar?: string | null;
      }) || {};
    const username = data.username ?? userId;

    try {
      // Fetch all client tokens except the triggering user
      const clientsSnapshot = await db
        .collection("clients")
        .where("user_id", "!=", userId)
        .get();

      if (clientsSnapshot.empty) {
        console.log("No clients found to notify");
        return;
      }

      const tokens: string[] = [];
      clientsSnapshot.forEach((doc) => {
        const clientData = doc.data();
        if (clientData.fcm_token) {
          tokens.push(clientData.fcm_token);
        }
      });

      if (tokens.length === 0) {
        console.log("No valid FCM tokens found");
        return;
      }

      console.log(`Sending notifications to ${tokens.length} devices`);

      // Message payload for both system tray and in-app
      const message: BaseMessage = {
        notification: {
          title: "⚡ Challenge Alert!",
          body: `${username} is ready to duel! Join the queue and prove your skills.`,
        },
        data: {
          type: "challenge_alert",
          userId: userId,
          username: username,
          userAvatar: data.avatar || "",
        },
        android: {
          priority: "high",
          ttl: 45 * 1000, // 45 seconds
        },
        apns: {
          headers: {
            "apns-priority": "10", // Immediate delivery
            "apns-push-type": "alert",
          },
          payload: {
            aps: {
              badge: 1,
              sound: "default",
              contentAvailable: true,
              "interruption-level": "time-sensitive",
            },
          },
        },
      };

      // Send in batches of 400 tokens
      const BATCH_SIZE = 400;
      const batches: string[][] = [];

      for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
        batches.push(tokens.slice(i, i + BATCH_SIZE));
      }

      const results = await Promise.allSettled(
        batches.map(async (batch, index) => {
          console.log(
            `Sending batch ${index + 1}/${batches.length} (${
              batch.length
            } tokens)`
          );

          return admin.messaging().sendEachForMulticast({
            ...message,
            tokens: batch,
          });
        })
      );

      // Log results
      let totalSuccess = 0;
      let totalFailure = 0;

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          const response = result.value;
          totalSuccess += response.successCount;
          totalFailure += response.failureCount;

          if (response.failureCount > 0) {
            console.warn(
              `Batch ${index + 1} had ${response.failureCount} failures`
            );
            response.responses.forEach((resp, tokenIndex) => {
              if (!resp.success) {
                console.warn(
                  `Token ${tokenIndex} failed:`,
                  resp.error?.message
                );
              }
            });
          }
        } else {
          console.error(`Batch ${index + 1} failed entirely:`, result.reason);
          totalFailure += batches[index].length;
        }
      });

      console.log(
        `FCM notifications completed: ${totalSuccess} successful, ${totalFailure} failed`
      );
    } catch (err) {
      console.error("Failed to send FCM notifications:", err);
    }
  }
);

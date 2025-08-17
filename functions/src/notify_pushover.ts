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

    if (!doc || !userId) {
      console.log("Invalid event data - missing document or userId");
      return;
    }

    const data =
      (doc.data() as {
        username?: string | null;
        avatar?: string | null;
      }) || {};
    const username = data.username ?? "A Challenger";

    try {
      // Rate limiting: prevent spam from rapid queue joins
      const recentJoinsRef = db.collection("recent_queue_joins").doc(userId);
      const recentJoin = await recentJoinsRef.get();

      if (recentJoin.exists) {
        const lastJoin = recentJoin.data()?.timestamp?.toDate();
        if (lastJoin && Date.now() - lastJoin.getTime() < 5000) {
          // 5 seconds
          console.log(`Rate limiting: ${userId} joined recently`);
          return;
        }
      }

      // Set rate limit record
      await recentJoinsRef.set({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Fetch all clients except the triggering user
      // We'll filter out those with both notifications disabled in-memory since
      // complex Firestore queries can be limiting and defaults are true
      const clientsSnapshot = await db
        .collection("clients")
        .where("user_id", "!=", userId)
        .get();

      if (clientsSnapshot.empty) {
        console.log("No clients found to notify");
        return;
      }

      // Group clients by notification preferences
      const notifyAllTokens: string[] = [];
      const foregroundOnlyTokens: string[] = [];

      clientsSnapshot.forEach((doc) => {
        const clientData = doc.data();
        if (clientData.fcm_token) {
          // Default to true if settings are missing
          const notifyAll = clientData.notify_background_queue_joins !== false;
          const notifyForegroundOnly =
            clientData.notify_foreground_queue_joins !== false;

          // Skip clients who have both notifications explicitly disabled
          if (!notifyAll && !notifyForegroundOnly) {
            return;
          }

          // Prioritize background notifications
          if (notifyAll) {
            notifyAllTokens.push(clientData.fcm_token);
          } else if (notifyForegroundOnly) {
            foregroundOnlyTokens.push(clientData.fcm_token);
          }
        }
      });

      const totalTokens = notifyAllTokens.length + foregroundOnlyTokens.length;
      if (totalTokens === 0) {
        console.log(
          "No valid FCM tokens found or all users have notifications disabled"
        );
        return;
      }

      console.log(
        `Sending notifications to ${notifyAllTokens.length} background devices and ${foregroundOnlyTokens.length} foreground devices`
      );

      const notification: BaseMessage["notification"] = {
        title: "⚡ Challenge Alert!",
        body: `${username} is ready to duel! Join the queue and prove your skills.`,
      };

      // Base message structure (shared components)
      const baseMessage: BaseMessage = {
        data: {
          type: "challenge_alert",
          userId: userId,
          username: username,
          userAvatar: data.avatar || "",
          ...notification,
        },
        android: {
          priority: "high" as const,
          ttl: 45 * 1000, // 45 seconds
        },
        apns: {
          headers: {
            "apns-priority": "10",
          },
          payload: {
            aps: {
              contentAvailable: true,
              badge: 1,
              sound: "default",
              "interruption-level": "time-sensitive",
            },
          },
        },
      };

      // Function to send messages in batches
      const sendBatches = async (
        tokens: string[],
        message: BaseMessage,
        messageType: string
      ) => {
        if (tokens.length === 0) return { success: 0, failure: 0 };

        const BATCH_SIZE = 400;
        const batches: string[][] = [];

        for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
          batches.push(tokens.slice(i, i + BATCH_SIZE));
        }

        const results = await Promise.allSettled(
          batches.map(async (batch, index) => {
            console.log(
              `Sending ${messageType} batch ${index + 1}/${batches.length} (${
                batch.length
              } tokens)`
            );

            return admin.messaging().sendEachForMulticast({
              ...message,
              tokens: batch,
            });
          })
        );

        let successCount = 0;
        let failureCount = 0;

        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            const response = result.value;
            successCount += response.successCount;
            failureCount += response.failureCount;

            if (response.failureCount > 0) {
              console.warn(
                `${messageType} batch ${index + 1} had ${
                  response.failureCount
                } failures`
              );
              response.responses.forEach((resp, tokenIndex) => {
                if (!resp.success) {
                  console.warn(
                    `${messageType} token ${tokenIndex} failed:`,
                    resp.error?.message
                  );
                }
              });
            }
          } else {
            console.error(
              `${messageType} batch ${index + 1} failed entirely:`,
              result.reason
            );
            failureCount += batches[index].length;
          }
        });

        return { success: successCount, failure: failureCount };
      };

      // Send messages to both groups
      const [backgroundResults, foregroundResults] = await Promise.all([
        sendBatches(
          notifyAllTokens,
          { ...baseMessage, notification },
          "background"
        ),
        sendBatches(foregroundOnlyTokens, baseMessage, "foreground"),
      ]);

      const totalSuccess =
        backgroundResults.success + foregroundResults.success;
      const totalFailure =
        backgroundResults.failure + foregroundResults.failure;

      console.log(
        `FCM notifications completed: ${totalSuccess} successful, ${totalFailure} failed ` +
          `(Background: ${backgroundResults.success}/${
            backgroundResults.success + backgroundResults.failure
          }, ` +
          `Foreground: ${foregroundResults.success}/${
            foregroundResults.success + foregroundResults.failure
          })`
      );
    } catch (err) {
      console.error("Failed to send FCM notifications:", err);
    }
  }
);

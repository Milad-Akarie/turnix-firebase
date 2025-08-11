import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";

const db = admin.firestore();

const QUEUE_TTL_SECONDS = 45;
const EXCLUDED_LEVELS_LIST = ["cls:37", "cls:51"]; // Add levels to exclude from random selection

// Function to generate a random puzzle ID excluding specified levels
function generateRandomPuzzleId(): string {
  let puzzleId: string;
  do {
    const randomNum = Math.floor(Math.random() * 283) + 20;
    puzzleId = "cls:" + randomNum;
  } while (EXCLUDED_LEVELS_LIST.includes(puzzleId));
  return puzzleId;
}

export const onQueueUpdated = onDocumentWritten(
  "match_queue/{userId}",
  async (event) => {
    const snap = event.data?.after;
    const userId = event.params.userId;
    console.log(`User ${userId} joined the queue`);

    if (!snap || !snap.exists) {
      console.log("No document data available");
      return;
    }

    try {
      const now = admin.firestore.Timestamp.now();

      const cutoff = admin.firestore.Timestamp.fromDate(
        new Date(now.toDate().getTime() - QUEUE_TTL_SECONDS * 1000)
      );

      const matchId = db.collection("matches").doc().id;
      const startAt = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 5000)
      ); // 5s delay

      // Atomically find partner and create match to prevent race conditions
      await db.runTransaction(async (tx) => {
        // Re-check current user's queue doc first
        const currentQueueDoc = await tx.get(snap.ref);
        if (!currentQueueDoc.exists) {
          console.log("Transaction aborted: Current user no longer in queue");
          return;
        }

        // Find partner within transaction to avoid race conditions
        const candidatesSnap = await tx.get(
          db
            .collection("match_queue")
            .where("joined_at", ">", cutoff)
            .orderBy("joined_at")
            .limit(2)
        );

        const availablePartner = candidatesSnap.docs.find(
          (doc) => doc.id !== userId && doc.exists
        );

        if (!availablePartner) {
          console.log(
            `Transaction aborted: No available partner found for user ${userId}`
          );
          return;
        }

        // Double-check partner still exists in transaction
        const partnerQueueDoc = await tx.get(availablePartner.ref);
        if (!partnerQueueDoc.exists) {
          console.log("Transaction aborted: Partner no longer in queue");
          return;
        }

        console.log(
          `Attempting to match user ${userId} with ${availablePartner.id}`
        );

        tx.set(db.collection("matches").doc(matchId), {
          players: [userId, availablePartner.id],
          start_at: startAt,
          puzzle_id: generateRandomPuzzleId(),
          created_at: now,
          max_duration: 85, // seconds
          player_states: {
            [userId]: {
              username: snap.data()?.username,
              avatar: snap.data()?.avatar,
            },
            [availablePartner.id]: {
              username: partnerQueueDoc.data()?.username,
              avatar: partnerQueueDoc.data()?.avatar,
            },
          },
        });

        tx.delete(snap.ref);
        tx.delete(availablePartner.ref);

        console.log(
          `Match created successfully: ${matchId} for users ${userId} and ${availablePartner.id}`
        );
      });
    } catch (error) {
      console.error(`Matchmaking failed for user ${userId}:`, error);
      // Optionally: Add retry logic or cleanup failed state
    }
  }
);

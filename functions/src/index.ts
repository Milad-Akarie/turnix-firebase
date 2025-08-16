import * as admin from "firebase-admin";
import { onCall } from "firebase-functions/v2/https";

if (!admin.apps.length) {
  admin.initializeApp();
}

// Import functions from separate modules
import { onMatchDeleted } from "./complete_match";
import { onQueueUpdated } from "./match_making";
import { notifyUsersOnQueueJoin } from "./notify_pushover";

// Export all functions
export { onMatchDeleted, onQueueUpdated, notifyUsersOnQueueJoin };

export const getServerTime = onCall(async () => {
  return {
    timestamp: admin.firestore.Timestamp.now().toMillis(),
  };
});

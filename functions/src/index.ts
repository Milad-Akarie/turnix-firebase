import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

// Import functions from separate modules
import { onMatchDeleted } from "./complete_match";
import { onQueueUpdated } from "./match_making";

// Export all functions
export { onMatchDeleted, onQueueUpdated };

import * as admin from "firebase-admin";
import { onCall } from "firebase-functions/v2/https";

const db = admin.firestore();

export const completeMatch = onCall({ cors: true }, async (request) => {
  const { matchId } = request.data;

  if (!matchId) {
    throw new Error("matchId is required");
  }

  if (!request.auth?.uid) {
    throw new Error("unauthenticated");
  }

  console.log(`Completing match: ${matchId}`);

  try {
    await db.runTransaction(async (tx) => {
      // Get the match document
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await tx.get(matchRef);

      if (!matchDoc.exists) {
        console.log(`Match ${matchId} already resolved`);
        return { success: true };
      }

      const matchData = matchDoc.data();
      if (!matchData) {
        console.log(`Match ${matchId} has no data`);
        return { success: false, error: "Match data not found" };
      }

      // eslint-disable-next-line camelcase
      const { players, player_states, created_at, start_at, puzzle_id } =
        matchData;
      let { winner } = matchData;

      // Check if match is already resolved
      if (winner) {
        console.log(`Match ${matchId} already resolved with winner: ${winner}`);
        return { success: true, winner, matchId };
      }

      // Check if winner is already decided
      if (!winner) {
        console.log(`Determining winner for match ${matchId}`);

        // Determine winner based on finishedAt timestamp, then progress
        let winnerPlayerId = null;
        const playerResults = [];

        // Collect player data for comparison
        for (const playerId of players) {
          // eslint-disable-next-line camelcase
          const playerState = player_states[playerId];

          // Validate player state exists
          if (!playerState) {
            console.warn(
              `Player state missing for player ${playerId}, using defaults`
            );
          }

          playerResults.push({
            playerId,
            finishedAt: playerState?.finished_at || null,
            progress: playerState?.progress || 0,
          });
        }

        // Sort by completion: finished players first (by finishedAt), then by progress
        playerResults.sort((a, b) => {
          // If both players finished, compare finishedAt timestamps
          if (a.finishedAt && b.finishedAt) {
            return a.finishedAt.toMillis() - b.finishedAt.toMillis();
          }
          // If only one player finished, they win
          if (a.finishedAt && !b.finishedAt) return -1;
          if (!a.finishedAt && b.finishedAt) return 1;

          // If neither finished, compare progress
          return b.progress - a.progress;
        });

        // Determine winner or draw
        const firstPlayer = playerResults[0];
        const secondPlayer = playerResults[1];

        if (firstPlayer.finishedAt && !secondPlayer.finishedAt) {
          // First player finished, second didn't
          winnerPlayerId = firstPlayer.playerId;
        } else if (!firstPlayer.finishedAt && !secondPlayer.finishedAt) {
          // Neither finished, compare progress
          if (firstPlayer.progress > secondPlayer.progress) {
            winnerPlayerId = firstPlayer.playerId;
          } else if (firstPlayer.progress === secondPlayer.progress) {
            // It's a draw - no winner
            winnerPlayerId = null;
          } else {
            winnerPlayerId = secondPlayer.playerId;
          }
        } else if (firstPlayer.finishedAt && secondPlayer.finishedAt) {
          // Both finished, winner is who finished first
          winnerPlayerId = firstPlayer.playerId;
        }

        winner = winnerPlayerId;
        const isDraw = winner === null;

        // Update match with winner
        tx.update(matchRef, {
          winner,
          isDraw,
          completed_at: admin.firestore.Timestamp.now(),
        });

        console.log(
          `Winner determined: ${winner || "draw"}${
            isDraw
              ? " (draw)"
              : ` (finished at: ${
                  firstPlayer.finishedAt
                    ? firstPlayer.finishedAt.toDate()
                    : "not finished"
                }, progress: ${firstPlayer.progress})`
          }`
        );
      }

      // Create match history entries for each player
      const completedAt = admin.firestore.Timestamp.now();

      for (const playerId of players) {
        // eslint-disable-next-line camelcase
        const playerState = player_states[playerId];
        const isDraw = winner === null;
        const isWinner = !isDraw && playerId === winner;
        const opponentId = players.find((p: string) => p !== playerId);

        // Validate opponent was found
        if (!opponentId) {
          console.error(`No opponent found for player ${playerId}`);
          continue; // Skip this player's history entry
        }

        // eslint-disable-next-line camelcase
        const opponentState = player_states[opponentId];

        // Calculate match duration safely
        let matchDuration = 0;
        try {
          // eslint-disable-next-line camelcase
          matchDuration = completedAt.toMillis() - start_at.toMillis();
          // Ensure duration is not negative
          if (matchDuration < 0) {
            console.warn(
              `Negative match duration calculated: ${matchDuration}ms, setting to 0`
            );
            matchDuration = 0;
          }
        } catch (error) {
          console.error(`Error calculating match duration:`, error);
          matchDuration = 0;
        }

        const historyEntry = {
          match_id: matchId,
          player_id: playerId,
          opponent_id: opponentId,
          opponent_username: opponentState?.username,
          // eslint-disable-next-line camelcase
          puzzle_id,
          result: isDraw ? "draw" : isWinner ? "win" : "loss",
          player_progress: playerState?.progress || 0,
          opponent_progress: opponentState?.progress || 0,
          player_finished_at: playerState?.finished_at || null,
          opponent_finished_at: opponentState?.finished_at || null,
          match_duration: matchDuration,
          completed_at: completedAt,
          // eslint-disable-next-line camelcase
          created_at: created_at || completedAt, // Fallback to completedAt if created_at is missing
        };

        // Add to match_history collection
        const historyRef = db.collection("match_history").doc();
        tx.set(historyRef, historyEntry);
      }

      console.log(`Match history entries created for match ${matchId}`);
      return { success: true, winner, matchId };
    });

    // Delete the match document after successful completion
    // This allows clients to receive the winner update before deletion
    // await db.collection("matches").doc(matchId).delete();
    // console.log(`Match document ${matchId} deleted`);

    return { success: true, matchId };
  } catch (error) {
    console.error(`Failed to complete match ${matchId}:`, error);
    throw new Error(
      `Failed to complete match: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

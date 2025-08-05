import * as admin from "firebase-admin";
import { onDocumentDeleted } from "firebase-functions/v2/firestore";

const db = admin.firestore();

export const onMatchDeleted = onDocumentDeleted(
  "matches/{matchId}",
  async (event) => {
    const matchId = event.params.matchId;
    const matchData = event.data?.data();

    if (!matchData) {
      console.log(`No data found for deleted match ${matchId}`);
      return;
    }

    console.log(`Processing deleted match: ${matchId}`);

    try {
      // Extract match data from the deleted document
      // eslint-disable-next-line camelcase
      const { players, player_states, created_at, start_at, puzzle_id } =
        matchData;
      let { winner } = matchData;

      // Check if match history entries should be created
      if (!players || !Array.isArray(players) || players.length === 0) {
        console.log(`No players found in deleted match ${matchId}`);
        return;
      }

      // Determine winner if not already decided
      if (!winner) {
        console.log(`Determining winner for deleted match ${matchId}`);

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

      const batch = db.batch();

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
        batch.set(historyRef, historyEntry);
      }

      // Commit all history entries
      await batch.commit();

      console.log(`Match history entries created for deleted match ${matchId}`);
    } catch (error) {
      console.error(`Failed to process deleted match ${matchId}:`, error);
    }
  }
);

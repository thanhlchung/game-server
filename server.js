const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const swaggerDocument = YAML.load('./openapi.yaml');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

const sessions = new Map();

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function normalisePlayerID(id) {
  return id.trim().toLowerCase();
}

function generateSessionID() {
  let id;
  do {
    id = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  } while (sessions.has(id));
  return id;
}

function normalizeGameState(gameState) {
  if (typeof gameState === 'string') return gameState;
  return JSON.stringify(gameState);
}

/**
 * Compute and **store** the fingerprint for a session.
 * `session._id` must already exist.
 */
function recomputeAndCacheGameStateID(session) {
  const currentPlayer = session.playerIDs[session.currentPlayerIndex];
  const data = JSON.stringify({
    gameState: session.gameState,
    sessionID: session._id,
    currentPlayer,
  });
  session.cachedGameStateID = crypto.createHash('md5').update(data).digest('base64');
}

/**
 * Return the cached fingerprint, computing it if missing (shouldn't normally happen).
 */
function getCachedGameStateID(session) {
  if (session.cachedGameStateID === undefined) {
    recomputeAndCacheGameStateID(session);
  }
  return session.cachedGameStateID;
}

/** Return the current player ID (or null if game not started). */
function getCurrentPlayerId(session) {
  if (!session.gameStarted) return null;
  return session.playerIDs[session.currentPlayerIndex];
}

// ---------------------------------------------------------------------------
//  Routes
// ---------------------------------------------------------------------------

// 1. Create session
app.post('/createSession', (req, res) => {
  const { gameID, playerID, gameState } = req.body;
  if (!gameID || !playerID || gameState === undefined) {
    return res.status(400).json({ error: 'Missing gameID, playerID, or gameState' });
  }

  const sessionID = generateSessionID();
  const normalisedOwner = normalisePlayerID(playerID);

  const session = {
    gameID,
    ownerID: normalisedOwner,
    playerIDs: [normalisedOwner],
    currentPlayerIndex: 0,
    gameState: normalizeGameState(gameState),
    gameStarted: false,
    cachedGameStateID: undefined,   // not started yet
  };
  session._id = sessionID;
  sessions.set(sessionID, session);

  res.json({ sessionID });
});

// 2. Join session
app.post('/joinSession', (req, res) => {
  const { gameID, sessionID, playerID } = req.body;
  if (!gameID || !sessionID || !playerID) {
    return res.status(400).json({ error: 'Missing gameID, sessionID, or playerID' });
  }

  const session = sessions.get(sessionID);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.gameID !== gameID) return res.json(false);
  if (session.gameStarted) return res.json(false);

  const normalisedPlayer = normalisePlayerID(playerID);
  if (session.playerIDs.some(p => p === normalisedPlayer)) return res.json(false);

  session.playerIDs.push(normalisedPlayer);
  res.json(true);
});

// 3. Start game
app.post('/startGame', (req, res) => {
  const { sessionID, playerID, playerList, gameState } = req.body;
  if (!sessionID || !playerID || !playerList || gameState === undefined) {
    return res.status(400).json({ error: 'Missing sessionID, playerID, playerList, or gameState' });
  }

  const session = sessions.get(sessionID);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.ownerID !== normalisePlayerID(playerID)) return res.json(false);

  session.playerIDs = playerList.map(p => normalisePlayerID(p));
  session.currentPlayerIndex = 0;
  session.gameState = normalizeGameState(gameState);
  session.gameStarted = true;

  recomputeAndCacheGameStateID(session);
  res.json(true);
});

// 4. Get players
app.get('/getPlayers', (req, res) => {
  const { sessionID } = req.query;
  if (!sessionID) return res.status(400).json({ error: 'Missing sessionID' });

  const session = sessions.get(sessionID);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({ players: session.playerIDs });
});

// 5. Update game state
app.post('/updateGameState', (req, res) => {
  const { sessionID, playerID, gameState } = req.body;
  if (!sessionID || !playerID || gameState === undefined) {
    return res.status(400).json({ error: 'Missing sessionID, playerID, or gameState' });
  }

  const session = sessions.get(sessionID);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.gameStarted) return res.json(false);

  const currentPlayer = session.playerIDs[session.currentPlayerIndex];
  if (normalisePlayerID(playerID) !== currentPlayer) return res.json(false);

  session.gameState = normalizeGameState(gameState);
  session.currentPlayerIndex = (session.currentPlayerIndex + 1) % session.playerIDs.length;

  recomputeAndCacheGameStateID(session);
  res.json(true);
});

// 6. Get game state (with optional long‑polling) — NOW INCLUDES currentPlayer
app.get('/getGameState', async (req, res) => {
  const { sessionID, gameStateID, waitTimeOut } = req.query;
  if (!sessionID) return res.status(400).json({ error: 'Missing sessionID' });

  const session = sessions.get(sessionID);
  if (!session) return res.json({ gameState: null, currentPlayer: null });

  const currentPlayer = getCurrentPlayerId(session);

  // Long‑poll logic
  if (gameStateID !== undefined && gameStateID !== '' && waitTimeOut !== undefined && waitTimeOut !== '') {
    let timeoutSec = parseFloat(waitTimeOut);
    if (isNaN(timeoutSec) || timeoutSec <= 0) timeoutSec = 5;
    if (timeoutSec > 30) timeoutSec = 30;

    const deadline = Date.now() + timeoutSec * 1000;
    const pollInterval = 200; // ms

    while (Date.now() < deadline) {
      if (getCachedGameStateID(session) !== gameStateID) {
        // State changed – return immediately
        return res.json({
          gameState: session.gameState,
          currentPlayer: getCurrentPlayerId(session)
        });
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    // Timeout with no change
    return res.json({
      gameState: session.gameState,
      currentPlayer: getCurrentPlayerId(session)
    });
  }

  // Normal immediate return
  res.json({
    gameState: session.gameState,
    currentPlayer
  });
});

// 7. Get current player (kept for backward compatibility, no longer used by default client)
app.get('/getCurrentPlayer', (req, res) => {
  const { sessionID } = req.query;
  if (!sessionID) return res.status(400).json({ error: 'Missing sessionID' });

  const session = sessions.get(sessionID);
  if (!session || !session.gameStarted) return res.json({ currentPlayer: null });

  res.json({ currentPlayer: session.playerIDs[session.currentPlayerIndex] });
});

// 8. Get game state ID
app.get('/getGameStateID', (req, res) => {
  const { sessionID } = req.query;
  if (!sessionID) return res.status(400).json({ error: 'Missing sessionID' });

  const session = sessions.get(sessionID);
  if (!session || !session.gameStarted) return res.json({ gameStateID: null });

  res.json({ gameStateID: getCachedGameStateID(session) });
});

// 9. End session
app.post('/endSession', (req, res) => {
  const { sessionID, playerID } = req.body;
  if (!sessionID || !playerID) return res.status(400).json({ error: 'Missing sessionID or playerID' });

  const session = sessions.get(sessionID);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.ownerID !== normalisePlayerID(playerID)) return res.json(false);

  sessions.delete(sessionID);
  res.json(true);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
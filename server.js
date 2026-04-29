const express = require('express');
const cors = require('cors');
const path = require('path');

// server.js
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON request bodies
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory session store
const sessions = new Map();
let nextSessionID = 1;

function generateSessionID() {
  return String(nextSessionID++);
}

// Helper: ensure gameState is stored as a string
function normalizeGameState(gameState) {
  if (typeof gameState === 'string') return gameState;
  return JSON.stringify(gameState);
}

// 1. Create session – expects JSON body: { gameID, playerID, gameState }
app.post('/createSession', (req, res) => {
  const { gameID, playerID, gameState } = req.body;

  if (!gameID || !playerID || gameState === undefined) {
    return res.status(400).json({ error: 'Missing gameID, playerID, or gameState in request body' });
  }

  const sessionID = generateSessionID();
  sessions.set(sessionID, {
    gameID,
    ownerID: playerID,
    playerIDs: [playerID],
    currentPlayerIndex: 0,
    gameState: normalizeGameState(gameState),
  });

  res.json({ sessionID });
});

// 2. Join session – expects JSON body: { sessionID, playerID }
app.post('/joinSession', (req, res) => {
  const { sessionID, playerID } = req.body;

  if (!sessionID || !playerID) {
    return res.status(400).json({ error: 'Missing sessionID or playerID in request body' });
  }

  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.playerIDs.includes(playerID)) {
    return res.json(false);
  }

  session.playerIDs.push(playerID);
  res.json(true);
});

// 3. Get players – uses query parameter: ?sessionID=...
app.get('/getPlayers', (req, res) => {
  const { sessionID } = req.query;

  if (!sessionID) {
    return res.status(400).json({ error: 'Missing sessionID query parameter' });
  }

  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({ players: session.playerIDs });
});

// 4. Update game state – expects JSON body: { sessionID, playerID, gameState }
app.post('/updateGameState', (req, res) => {
  const { sessionID, playerID, gameState } = req.body;

  if (!sessionID || !playerID || gameState === undefined) {
    return res.status(400).json({ error: 'Missing sessionID, playerID, or gameState in request body' });
  }

  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const currentPlayer = session.playerIDs[session.currentPlayerIndex];
  if (playerID !== currentPlayer) {
    return res.json(false);
  }

  session.gameState = normalizeGameState(gameState);
  session.currentPlayerIndex = (session.currentPlayerIndex + 1) % session.playerIDs.length;

  res.json(true);
});

// 5. Get game state – uses query parameter: ?sessionID=...
app.get('/getGameState', (req, res) => {
  const { sessionID } = req.query;

  if (!sessionID) {
    return res.status(400).json({ error: 'Missing sessionID query parameter' });
  }

  const session = sessions.get(sessionID);
  if (!session) {
    return res.json({ gameState: null });
  }

  res.json({ gameState: session.gameState });
});

// 6. End session – expects JSON body: { sessionID, playerID }
app.post('/endSession', (req, res) => {
  const { sessionID, playerID } = req.body;

  if (!sessionID || !playerID) {
    return res.status(400).json({ error: 'Missing sessionID or playerID in request body' });
  }

  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.ownerID !== playerID) {
    return res.json(false);
  }

  sessions.delete(sessionID);
  res.json(true);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
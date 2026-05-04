const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const swaggerDocument = YAML.load(path.join(__dirname, 'openapi.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

const sessions = new Map();

function normalizePlayerID(playerID) {
  return String(playerID).trim().toLowerCase();
}

function normalizeGameState(gameState) {
  if (typeof gameState === 'string') {
    return gameState;
  }
  return JSON.stringify(gameState);
}

function generateSessionID() {
  let id;
  do {
    const num = Math.floor(Math.random() * 1000);
    id = num.toString().padStart(3, '0');
  } while (sessions.has(id));
  return id;
}

function computeFingerprint(session) {
  const currentPlayer = session.playerIDs[session.currentPlayerIndex];
  const payload = {
    gameState: session.gameState,
    sessionID: session._id,
    currentPlayer: currentPlayer
  };
  const json = JSON.stringify(payload);
  const hash = crypto.createHash('md5').update(json, 'utf-8').digest();
  const base64 = hash.toString('base64');
  session.cachedGameStateID = base64;
  return base64;
}

function getCachedFingerprint(session) {
  if (session.cachedGameStateID === undefined) {
    return computeFingerprint(session);
  }
  return session.cachedGameStateID;
}

function getCurrentPlayer(session) {
  if (!session.gameStarted) {
    return null;
  }
  return session.playerIDs[session.currentPlayerIndex];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.post('/createSession', (req, res) => {
  const { gameID, playerID, gameState } = req.body;
  if (gameID === undefined || playerID === undefined || gameState === undefined) {
    return res.status(400).json({ error: 'Missing gameID, playerID, or gameState' });
  }
  const sessionID = generateSessionID();
  const normalizedPlayerID = normalizePlayerID(playerID);
  const session = {
    _id: sessionID,
    gameID: gameID,
    ownerID: normalizedPlayerID,
    playerIDs: [normalizedPlayerID],
    currentPlayerIndex: 0,
    gameState: normalizeGameState(gameState),
    gameStarted: false,
    cachedGameStateID: undefined
  };
  sessions.set(sessionID, session);
  res.status(200).json({ sessionID });
});

app.post('/joinSession', (req, res) => {
  const { gameID, sessionID, playerID } = req.body;
  if (gameID === undefined || sessionID === undefined || playerID === undefined) {
    return res.status(400).json({ error: 'Missing gameID, sessionID, or playerID' });
  }
  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.gameID !== gameID) {
    return res.status(200).json(false);
  }
  if (session.gameStarted) {
    return res.status(200).json(false);
  }
  const normalizedPlayerID = normalizePlayerID(playerID);
  if (session.playerIDs.includes(normalizedPlayerID)) {
    return res.status(200).json(false);
  }
  session.playerIDs.push(normalizedPlayerID);
  res.status(200).json(true);
});

app.post('/startGame', (req, res) => {
  const { sessionID, playerID, playerList, gameState } = req.body;
  if (sessionID === undefined || playerID === undefined || playerList === undefined || gameState === undefined) {
    return res.status(400).json({ error: 'Missing sessionID, playerID, playerList, or gameState' });
  }
  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const normalizedPlayerID = normalizePlayerID(playerID);
  if (normalizedPlayerID !== session.ownerID) {
    return res.status(200).json(false);
  }
  session.playerIDs = playerList.map(pid => normalizePlayerID(pid));
  session.currentPlayerIndex = 0;
  session.gameState = normalizeGameState(gameState);
  session.gameStarted = true;
  computeFingerprint(session);
  res.status(200).json(true);
});

app.get('/getPlayers', (req, res) => {
  const { sessionID } = req.query;
  if (sessionID === undefined || sessionID === '') {
    return res.status(400).json({ error: 'Missing sessionID' });
  }
  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.status(200).json({ players: session.playerIDs });
});

app.post('/updateGameState', (req, res) => {
  const { sessionID, playerID, gameState } = req.body;
  if (sessionID === undefined || playerID === undefined || gameState === undefined) {
    return res.status(400).json({ error: 'Missing sessionID, playerID, or gameState' });
  }
  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (!session.gameStarted) {
    return res.status(200).json(false);
  }
  const currentPlayer = session.playerIDs[session.currentPlayerIndex];
  const normalizedPlayerID = normalizePlayerID(playerID);
  if (normalizedPlayerID !== currentPlayer) {
    return res.status(200).json(false);
  }
  session.gameState = normalizeGameState(gameState);
  session.currentPlayerIndex = (session.currentPlayerIndex + 1) % session.playerIDs.length;
  computeFingerprint(session);
  res.status(200).json(true);
});

app.get('/getGameState', async (req, res) => {
  const { sessionID, gameStateID, waitTimeOut } = req.query;
  if (sessionID === undefined || sessionID === '') {
    return res.status(400).json({ error: 'Missing sessionID' });
  }
  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(200).json({ gameState: null, currentPlayer: null });
  }
  const currentPlayer = getCurrentPlayer(session);
  
  const hasGameStateID = gameStateID !== undefined && gameStateID !== '';
  const hasWaitTimeOut = waitTimeOut !== undefined && waitTimeOut !== '';
  
  if (hasGameStateID && hasWaitTimeOut) {
    let timeoutSec = parseFloat(waitTimeOut);
    if (isNaN(timeoutSec) || timeoutSec <= 0) {
      timeoutSec = 5;
    }
    if (timeoutSec > 30) {
      timeoutSec = 30;
    }
    const deadline = Date.now() + (timeoutSec * 1000);
    while (Date.now() < deadline) {
      const currentFingerprint = getCachedFingerprint(session);
      if (currentFingerprint !== gameStateID) {
        return res.status(200).json({ gameState: session.gameState, currentPlayer });
      }
      await sleep(200);
    }
    return res.status(200).json({ gameState: session.gameState, currentPlayer });
  }
  
  res.status(200).json({ gameState: session.gameState, currentPlayer });
});

app.get('/getCurrentPlayer', (req, res) => {
  const { sessionID } = req.query;
  if (sessionID === undefined || sessionID === '') {
    return res.status(400).json({ error: 'Missing sessionID' });
  }
  const session = sessions.get(sessionID);
  if (!session || !session.gameStarted) {
    return res.status(200).json({ currentPlayer: null });
  }
  res.status(200).json({ currentPlayer: session.playerIDs[session.currentPlayerIndex] });
});

app.get('/getGameStateID', (req, res) => {
  const { sessionID } = req.query;
  if (sessionID === undefined || sessionID === '') {
    return res.status(400).json({ error: 'Missing sessionID' });
  }
  const session = sessions.get(sessionID);
  if (!session || !session.gameStarted) {
    return res.status(200).json({ gameStateID: null });
  }
  res.status(200).json({ gameStateID: getCachedFingerprint(session) });
});

app.post('/endSession', (req, res) => {
  const { sessionID, playerID } = req.body;
  if (sessionID === undefined || playerID === undefined) {
    return res.status(400).json({ error: 'Missing sessionID or playerID' });
  }
  const session = sessions.get(sessionID);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const normalizedPlayerID = normalizePlayerID(playerID);
  if (normalizedPlayerID !== session.ownerID) {
    return res.status(200).json(false);
  }
  sessions.delete(sessionID);
  res.status(200).json(true);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
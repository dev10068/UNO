/**
 * Offline-First P2P Multiplayer Uno Game
 * Uses PeerJS for WebRTC-based multiplayer
 */

// ============ Game Constants ============
const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const WILD_CARDS = ['wild', 'wild4'];
const ACTION_ICONS = {
  skip: '⊘',
  reverse: '⇄',
  draw2: '+2',
  wild: '★',
  wild4: '+4'
};

// ============ State ============
const state = {
  mode: null, // 'offline', 'host', 'client'
  playerId: null,
  playerName: 'Player',
  roomCode: null,
  roomCapacity: 4,
  
  // Networking
  peer: null,
  connections: new Map(), // peerId -> connection
  hostConnection: null,   // For clients
  
  // Game State
  players: [],          // [{id, name, cardCount, isHost, connected}]
  hand: [],             // Current player's cards
  discardPile: [],
  drawPile: [],
  currentPlayerIndex: 0,
  direction: 1,         // 1 = clockwise, -1 = counter-clockwise
  currentColor: null,
  gameStarted: false,
  isMyTurn: false,
  mustDraw: 0,
  unoCalled: false,
  
  // UI
  selectedCardIndex: null,
  chatOpen: false
};

// ============ DOM Elements ============
const $ = (id) => document.getElementById(id);
const screens = {
  connection: $('connection-screen'),
  lobby: $('lobby-screen'),
  game: $('game-screen'),
  gameover: $('gameover-screen')
};

// ============ Utilities ============
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function notify(message, type = 'info') {
  const container = $('notifications');
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function showScreen(screenName) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenName].classList.add('active');
}

function setStatus(message, isError = false) {
  const el = $('connection-status');
  el.textContent = message;
  el.className = `status-message ${isError ? 'error' : message ? 'success' : ''}`;
}

// ============ Card Generation ============
function createDeck() {
  const deck = [];
  
  COLORS.forEach(color => {
    // One 0 per color
    deck.push({ color, value: '0', id: `${color}-0` });
    
    // Two of each 1-9 and actions
    VALUES.slice(1).forEach(value => {
      deck.push({ color, value, id: `${color}-${value}-1` });
      deck.push({ color, value, id: `${color}-${value}-2` });
    });
  });
  
  // 4 of each wild
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild', id: `wild-${i}` });
    deck.push({ color: 'wild', value: 'wild4', id: `wild4-${i}` });
  }
  
  return shuffleArray(deck);
}

function createCardElement(card, clickable = false) {
  const el = document.createElement('div');
  el.className = `card ${card.color}`;
  el.dataset.cardId = card.id;
  
  const isAction = ['skip', 'reverse', 'draw2', 'wild', 'wild4'].includes(card.value);
  const displayValue = isAction ? ACTION_ICONS[card.value] : card.value;
  
  el.innerHTML = `
    <span class="corner top-left">${displayValue}</span>
    <span class="${isAction ? 'action-icon' : 'value'}">${displayValue}</span>
    <span class="corner bottom-right">${displayValue}</span>
  `;
  
  if (clickable) {
    el.addEventListener('click', () => handleCardClick(card));
  }
  
  return el;
}

// ============ Game Logic ============
function canPlayCard(card, topCard, currentColor) {
  if (card.color === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function dealCards(numPlayers) {
  const deck = createDeck();
  const hands = Array.from({ length: numPlayers }, () => []);
  
  // Deal 7 cards to each player
  for (let i = 0; i < 7; i++) {
    for (let p = 0; p < numPlayers; p++) {
      hands[p].push(deck.pop());
    }
  }
  
  // Find first non-action card for discard pile
  let firstDiscard;
  do {
    firstDiscard = deck.pop();
    if (['wild4', 'wild'].includes(firstDiscard.value)) {
      deck.unshift(firstDiscard);
      firstDiscard = null;
    }
  } while (!firstDiscard);
  
  return { hands, drawPile: deck, discardPile: [firstDiscard] };
}

function getNextPlayerIndex() {
  let next = state.currentPlayerIndex + state.direction;
  if (next >= state.players.length) next = 0;
  if (next < 0) next = state.players.length - 1;
  return next;
}

function applyCardEffect(card) {
  switch (card.value) {
    case 'skip':
      state.currentPlayerIndex = getNextPlayerIndex();
      notify(`${state.players[state.currentPlayerIndex].name} was skipped!`);
      break;
    case 'reverse':
      state.direction *= -1;
      $('direction-indicator').classList.toggle('reversed');
      if (state.players.length === 2) {
        state.currentPlayerIndex = getNextPlayerIndex();
      }
      notify('Direction reversed!');
      break;
    case 'draw2':
      state.mustDraw = 2;
      break;
    case 'wild4':
      state.mustDraw = 4;
      break;
  }
}

function checkWinner() {
  const winner = state.players.find((p, i) => {
    if (state.mode === 'offline') {
      return i === 0 ? state.hand.length === 0 : p.cardCount === 0;
    }
    return p.cardCount === 0;
  });
  
  if (winner) {
    endGame(winner);
    return true;
  }
  return false;
}

function endGame(winner) {
  state.gameStarted = false;
  $('winner-text').textContent = `${winner.name} Wins!`;
  
  const scoresHtml = state.players.map(p => {
    const cards = p.id === state.playerId ? state.hand.length : p.cardCount;
    return `
      <div class="score-row ${p.id === winner.id ? 'winner' : ''}">
        <span>${p.name}</span>
        <span>${cards} cards left</span>
      </div>
    `;
  }).join('');
  
  $('final-scores').innerHTML = scoresHtml;
  showScreen('gameover');
}

// ============ UI Updates ============
function updateHand() {
  const container = $('player-hand');
  container.innerHTML = '';
  
  const topCard = state.discardPile[state.discardPile.length - 1];
  
  state.hand.forEach((card, index) => {
    const el = createCardElement(card, true);
    const playable = state.isMyTurn && canPlayCard(card, topCard, state.currentColor);
    if (playable) el.classList.add('playable');
    if (index === state.selectedCardIndex) el.classList.add('selected');
    container.appendChild(el);
  });
  
  // Show UNO button when down to 2 cards
  $('btn-uno').classList.toggle('hidden', state.hand.length !== 2 || state.unoCalled);
  $('btn-draw').disabled = !state.isMyTurn;
}

function updateDiscardPile() {
  const container = $('discard-pile');
  container.innerHTML = '';
  
  if (state.discardPile.length > 0) {
    const topCard = state.discardPile[state.discardPile.length - 1];
    const cardEl = createCardElement({
      ...topCard,
      color: state.currentColor || topCard.color
    });
    container.appendChild(cardEl);
  }
}

function updateOpponents() {
  const container = $('opponents-area');
  container.innerHTML = '';
  
  state.players.forEach((player, index) => {
    if (player.id === state.playerId) return;
    
    const el = document.createElement('div');
    el.className = `opponent ${index === state.currentPlayerIndex ? 'current-turn' : ''} ${player.unoCalled ? 'uno-called' : ''}`;
    el.innerHTML = `
      <span class="name">${player.name}</span>
      <span class="card-count">${player.cardCount}</span>
    `;
    container.appendChild(el);
  });
}

function updateTurnIndicator() {
  const indicator = $('turn-indicator');
  if (state.isMyTurn) {
    indicator.textContent = 'Your Turn';
    indicator.classList.remove('waiting');
  } else {
    const currentPlayer = state.players[state.currentPlayerIndex];
    indicator.textContent = currentPlayer ? `${currentPlayer.name}'s Turn` : 'Waiting...';
    indicator.classList.add('waiting');
  }
}

function updateLobby() {
  const container = $('players-list');
  container.innerHTML = '';
  
  for (let i = 0; i < state.roomCapacity; i++) {
    const player = state.players[i];
    const el = document.createElement('div');
    
    if (player) {
      el.className = `player-slot ${player.isHost ? 'host' : ''} ${player.id === state.playerId ? 'you' : ''}`;
      el.innerHTML = `
        <div class="avatar">${player.isHost ? '👑' : '👤'}</div>
        <span class="name">${player.name}</span>
      `;
    } else {
      el.className = 'player-slot empty';
      el.innerHTML = `
        <div class="avatar">?</div>
        <span class="name">Waiting...</span>
      `;
    }
    
    container.appendChild(el);
  }
  
  // Show start button only for host with 2+ players
  const canStart = state.mode === 'host' && state.players.length >= 2;
  $('btn-start-game').classList.toggle('hidden', !canStart);
}

function showColorPicker() {
  const picker = $('color-picker');
  picker.classList.remove('hidden');
}

function hideColorPicker() {
  $('color-picker').classList.add('hidden');
}

// ============ Game Actions ============
function handleCardClick(card) {
  if (!state.isMyTurn) return;
  
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (!canPlayCard(card, topCard, state.currentColor)) {
    notify('Cannot play this card', 'warning');
    return;
  }
  
  const cardIndex = state.hand.findIndex(c => c.id === card.id);
  
  if (card.color === 'wild') {
    state.selectedCardIndex = cardIndex;
    updateHand();
    showColorPicker();
    return;
  }
  
  playCard(cardIndex);
}

function playCard(cardIndex, chosenColor = null) {
  const card = state.hand[cardIndex];
  state.hand.splice(cardIndex, 1);
  
  if (chosenColor) {
    state.currentColor = chosenColor;
  } else {
    state.currentColor = card.color;
  }
  
  state.discardPile.push(card);
  state.selectedCardIndex = null;
  
  applyCardEffect(card);
  
  // Check UNO
  if (state.hand.length === 1 && !state.unoCalled) {
    notify('You forgot to call UNO!', 'warning');
    drawCards(2);
  }
  state.unoCalled = false;
  
  if (checkWinner()) return;
  
  advanceTurn();
  
  if (state.mode !== 'offline') {
    broadcastGameState();
  }
}

function drawCards(count = 1) {
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) {
      // Reshuffle discard pile
      const topCard = state.discardPile.pop();
      state.drawPile = shuffleArray(state.discardPile);
      state.discardPile = [topCard];
    }
    
    if (state.drawPile.length > 0) {
      state.hand.push(state.drawPile.pop());
    }
  }
}

function handleDraw() {
  if (!state.isMyTurn) return;
  
  const drawCount = state.mustDraw > 0 ? state.mustDraw : 1;
  drawCards(drawCount);
  state.mustDraw = 0;
  
  advanceTurn();
  
  if (state.mode !== 'offline') {
    broadcastGameState();
  }
}

function callUno() {
  state.unoCalled = true;
  notify('UNO!', 'success');
  $('btn-uno').classList.add('hidden');
  
  if (state.mode !== 'offline') {
    broadcast({ type: 'uno', playerId: state.playerId });
  }
}

function advanceTurn() {
  state.currentPlayerIndex = getNextPlayerIndex();
  
  // Handle draw stacks for next player
  if (state.mustDraw > 0 && state.mode === 'offline') {
    const nextIsPlayer = state.currentPlayerIndex === 0;
    if (!nextIsPlayer) {
      // AI draws
      state.players[state.currentPlayerIndex].cardCount += state.mustDraw;
      notify(`${state.players[state.currentPlayerIndex].name} draws ${state.mustDraw} cards`);
      state.mustDraw = 0;
      state.currentPlayerIndex = getNextPlayerIndex();
    }
  }
  
  state.isMyTurn = state.players[state.currentPlayerIndex].id === state.playerId;
  updateGame();
  
  // AI turn in offline mode
  if (state.mode === 'offline' && !state.isMyTurn) {
    setTimeout(aiTurn, 1000);
  }
}

function updateGame() {
  updateHand();
  updateDiscardPile();
  updateOpponents();
  updateTurnIndicator();
}

// ============ AI (Offline Mode) ============
function aiTurn() {
  if (!state.gameStarted || state.isMyTurn) return;
  
  const aiIndex = state.currentPlayerIndex;
  const ai = state.players[aiIndex];
  const topCard = state.discardPile[state.discardPile.length - 1];
  
  // Simulate AI having cards
  const aiCardCount = ai.cardCount;
  
  // 70% chance to play if they have cards
  const canPlay = Math.random() < 0.7 && aiCardCount > 0;
  
  if (canPlay) {
    // Fake playing a card
    ai.cardCount--;
    
    // Randomly decide card type
    const playedWild = Math.random() < 0.15;
    const newColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    
    const fakeCard = playedWild 
      ? { color: 'wild', value: Math.random() < 0.5 ? 'wild' : 'wild4', id: 'ai-wild' }
      : { color: newColor, value: VALUES[Math.floor(Math.random() * VALUES.length)], id: 'ai-card' };
    
    state.discardPile.push(fakeCard);
    state.currentColor = newColor;
    
    applyCardEffect(fakeCard);
    notify(`${ai.name} played a card`);
    
    if (ai.cardCount === 1) {
      notify(`${ai.name}: UNO!`, 'warning');
      ai.unoCalled = true;
    }
    
    if (ai.cardCount === 0) {
      endGame(ai);
      return;
    }
  } else {
    ai.cardCount++;
    notify(`${ai.name} drew a card`);
  }
  
  advanceTurn();
}

// ============ Networking (PeerJS) ============
function initPeer() {
  return new Promise((resolve, reject) => {
    state.peer = new Peer();
    
    state.peer.on('open', (id) => {
      state.playerId = id;
      resolve(id);
    });
    
    state.peer.on('error', (err) => {
      console.error('Peer error:', err);
      setStatus(`Connection error: ${err.type}`, true);
      reject(err);
    });
    
    state.peer.on('connection', handleIncomingConnection);
  });
}

function handleIncomingConnection(conn) {
  if (state.mode !== 'host') return;
  
  if (state.players.length >= state.roomCapacity) {
    conn.on('open', () => {
      conn.send({ type: 'error', message: 'Room is full' });
      conn.close();
    });
    return;
  }
  
  conn.on('open', () => {
    state.connections.set(conn.peer, conn);
  });
  
  conn.on('data', (data) => handleMessage(data, conn));
  
  conn.on('close', () => {
    handlePlayerDisconnect(conn.peer);
  });
}

function connectToHost(hostId) {
  return new Promise((resolve, reject) => {
    const conn = state.peer.connect(hostId, { reliable: true });
    
    conn.on('open', () => {
      state.hostConnection = conn;
      conn.send({ type: 'join', name: state.playerName, id: state.playerId });
      resolve();
    });
    
    conn.on('data', (data) => handleMessage(data, conn));
    
    conn.on('close', () => {
      notify('Disconnected from host', 'error');
      resetToMenu();
    });
    
    conn.on('error', reject);
  });
}

function handleMessage(data, conn) {
  switch (data.type) {
    case 'join':
      if (state.mode === 'host') {
        const newPlayer = { id: data.id, name: data.name, cardCount: 0, isHost: false, connected: true };
        state.players.push(newPlayer);
        updateLobby();
        broadcast({ type: 'lobby', players: state.players, capacity: state.roomCapacity });
        notify(`${data.name} joined`);
      }
      break;
      
    case 'lobby':
      state.players = data.players;
      state.roomCapacity = data.capacity;
      updateLobby();
      break;
      
    case 'start':
      state.gameStarted = true;
      state.hand = data.hand;
      state.discardPile = data.discardPile;
      state.currentColor = data.currentColor;
      state.currentPlayerIndex = data.currentPlayerIndex;
      state.direction = data.direction;
      state.players = data.players;
      state.isMyTurn = state.players[state.currentPlayerIndex].id === state.playerId;
      showScreen('game');
      $('chat-container').classList.remove('hidden');
      $('btn-chat-toggle').classList.remove('hidden');
      updateGame();
      break;
      
    case 'gameState':
      state.discardPile = data.discardPile;
      state.currentColor = data.currentColor;
      state.currentPlayerIndex = data.currentPlayerIndex;
      state.direction = data.direction;
      state.players = data.players;
      state.mustDraw = data.mustDraw || 0;
      state.isMyTurn = state.players[state.currentPlayerIndex].id === state.playerId;
      
      if (state.mustDraw > 0 && state.isMyTurn) {
        notify(`You must draw ${state.mustDraw} cards!`, 'warning');
      }
      
      updateGame();
      break;
      
    case 'dealCards':
      state.hand = data.cards;
      updateHand();
      break;
      
    case 'playCard':
      if (state.mode === 'host') {
        // Validate and apply card play
        const playerIndex = state.players.findIndex(p => p.id === data.playerId);
        if (playerIndex !== -1) {
          state.players[playerIndex].cardCount--;
          state.discardPile.push(data.card);
          state.currentColor = data.color;
          applyCardEffect(data.card);
          
          if (state.players[playerIndex].cardCount === 0) {
            broadcast({ type: 'gameOver', winner: state.players[playerIndex] });
            endGame(state.players[playerIndex]);
            return;
          }
          
          advanceTurn();
          broadcastGameState();
        }
      }
      break;
      
    case 'draw':
      if (state.mode === 'host') {
        const playerIndex = state.players.findIndex(p => p.id === data.playerId);
        if (playerIndex !== -1) {
          const drawCount = state.mustDraw > 0 ? state.mustDraw : 1;
          const drawnCards = [];
          
          for (let i = 0; i < drawCount; i++) {
            if (state.drawPile.length === 0) {
              const topCard = state.discardPile.pop();
              state.drawPile = shuffleArray(state.discardPile);
              state.discardPile = [topCard];
            }
            if (state.drawPile.length > 0) {
              drawnCards.push(state.drawPile.pop());
            }
          }
          
          state.players[playerIndex].cardCount += drawnCards.length;
          state.mustDraw = 0;
          
          // Send cards to player
          const playerConn = state.connections.get(data.playerId);
          if (playerConn) {
            playerConn.send({ type: 'dealCards', cards: drawnCards });
          } else if (data.playerId === state.playerId) {
            state.hand.push(...drawnCards);
          }
          
          advanceTurn();
          broadcastGameState();
        }
      }
      break;
      
    case 'uno':
      const unoPlayer = state.players.find(p => p.id === data.playerId);
      if (unoPlayer) {
        unoPlayer.unoCalled = true;
        notify(`${unoPlayer.name}: UNO!`, 'warning');
        updateOpponents();
      }
      break;
      
    case 'chat':
      addChatMessage(data.sender, data.message);
      break;
      
    case 'gameOver':
      endGame(data.winner);
      break;
      
    case 'error':
      notify(data.message, 'error');
      break;
  }
}

function broadcast(data) {
  if (state.mode === 'host') {
    state.connections.forEach(conn => {
      if (conn.open) conn.send(data);
    });
  } else if (state.hostConnection && state.hostConnection.open) {
    state.hostConnection.send(data);
  }
}

function broadcastGameState() {
  if (state.mode !== 'host') {
    // Clients send their actions to host
    return;
  }
  
  broadcast({
    type: 'gameState',
    discardPile: state.discardPile,
    currentColor: state.currentColor,
    currentPlayerIndex: state.currentPlayerIndex,
    direction: state.direction,
    players: state.players.map(p => ({ ...p, hand: undefined })),
    mustDraw: state.mustDraw
  });
  
  updateGame();
}

function handlePlayerDisconnect(peerId) {
  const playerIndex = state.players.findIndex(p => p.id === peerId);
  if (playerIndex !== -1) {
    const player = state.players[playerIndex];
    notify(`${player.name} disconnected`, 'warning');
    state.players.splice(playerIndex, 1);
    state.connections.delete(peerId);
    
    if (state.gameStarted) {
      // Adjust current player index if needed
      if (state.currentPlayerIndex >= state.players.length) {
        state.currentPlayerIndex = 0;
      }
      broadcastGameState();
    } else {
      updateLobby();
      broadcast({ type: 'lobby', players: state.players, capacity: state.roomCapacity });
    }
  }
}

// ============ Chat ============
function addChatMessage(sender, message, isSystem = false) {
  const container = $('chat-messages');
  const el = document.createElement('div');
  el.className = `chat-message ${isSystem ? 'system' : ''}`;
  
  if (isSystem) {
    el.textContent = message;
  } else {
    el.innerHTML = `<span class="sender">${sender}:</span>${message}`;
  }
  
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function sendChat() {
  const input = $('chat-input');
  const message = input.value.trim();
  if (!message) return;
  
  addChatMessage(state.playerName, message);
  broadcast({ type: 'chat', sender: state.playerName, message });
  input.value = '';
}

// ============ Mode Handlers ============
async function startOfflineGame() {
  state.mode = 'offline';
  state.playerId = 'player';
  state.playerName = $('player-name').value.trim() || 'You';
  
  // Create AI opponents
  state.players = [
    { id: 'player', name: state.playerName, cardCount: 0, isHost: true },
    { id: 'ai1', name: 'Bot Alex', cardCount: 7, isHost: false },
    { id: 'ai2', name: 'Bot Sam', cardCount: 7, isHost: false },
    { id: 'ai3', name: 'Bot Jordan', cardCount: 7, isHost: false }
  ];
  
  const { hands, drawPile, discardPile } = dealCards(state.players.length);
  state.hand = hands[0];
  state.drawPile = drawPile;
  state.discardPile = discardPile;
  state.currentColor = discardPile[0].color;
  state.currentPlayerIndex = 0;
  state.direction = 1;
  state.isMyTurn = true;
  state.gameStarted = true;
  
  showScreen('game');
  updateGame();
}

async function createRoom() {
  state.mode = 'host';
  state.playerName = $('player-name').value.trim() || 'Host';
  state.roomCapacity = parseInt($('room-capacity').value);
  
  setStatus('Creating room...');
  
  try {
    await initPeer();
    state.roomCode = state.playerId.substring(0, 8).toUpperCase();
    
    state.players = [{
      id: state.playerId,
      name: state.playerName,
      cardCount: 0,
      isHost: true,
      connected: true
    }];
    
    $('display-room-code').textContent = state.roomCode;
    showScreen('lobby');
    updateLobby();
    
    $('chat-container').classList.remove('hidden');
    $('btn-chat-toggle').classList.remove('hidden');
    addChatMessage(null, 'Room created. Share the code!', true);
    
  } catch (err) {
    setStatus('Failed to create room', true);
  }
}

async function joinRoom() {
  const code = $('room-code').value.trim().toUpperCase();
  if (!code) {
    setStatus('Enter a room code', true);
    return;
  }
  
  state.mode = 'client';
  state.playerName = $('player-name').value.trim() || 'Player';
  state.roomCode = code;
  
  setStatus('Connecting...');
  
  try {
    await initPeer();
    
    // Construct host peer ID from room code
    const hostId = code.toLowerCase() + state.peer.id.substring(8);
    
    // Try connecting with just the code first
    try {
      await connectToHost(code.toLowerCase());
    } catch {
      // If that fails, the code might be the full peer ID prefix
      await connectToHost(code);
    }
    
    $('display-room-code').textContent = code;
    showScreen('lobby');
    
    $('chat-container').classList.remove('hidden');
    $('btn-chat-toggle').classList.remove('hidden');
    addChatMessage(null, 'Connected to room', true);
    
  } catch (err) {
    setStatus('Failed to connect. Check the code.', true);
  }
}

function startMultiplayerGame() {
  if (state.mode !== 'host' || state.players.length < 2) return;
  
  const { hands, drawPile, discardPile } = dealCards(state.players.length);
  state.drawPile = drawPile;
  state.discardPile = discardPile;
  state.currentColor = discardPile[0].color;
  state.currentPlayerIndex = 0;
  state.direction = 1;
  state.gameStarted = true;
  state.hand = hands[0];
  
  // Update player card counts
  state.players.forEach((p, i) => {
    p.cardCount = 7;
  });
  
  // Send hands to each player
  state.players.forEach((player, index) => {
    if (player.id === state.playerId) {
      state.hand = hands[index];
    } else {
      const conn = state.connections.get(player.id);
      if (conn) {
        conn.send({
          type: 'start',
          hand: hands[index],
          discardPile: state.discardPile,
          currentColor: state.currentColor,
          currentPlayerIndex: 0,
          direction: 1,
          players: state.players.map(p => ({ ...p, hand: undefined }))
        });
      }
    }
  });
  
  state.isMyTurn = state.players[0].id === state.playerId;
  showScreen('game');
  updateGame();
  
  addChatMessage(null, 'Game started!', true);
}

function resetToMenu() {
  state.gameStarted = false;
  state.players = [];
  state.hand = [];
  state.connections.clear();
  
  if (state.peer) {
    state.peer.destroy();
    state.peer = null;
  }
  
  state.hostConnection = null;
  state.mode = null;
  
  hideColorPicker();
  $('chat-container').classList.add('hidden');
  $('btn-chat-toggle').classList.add('hidden');
  $('room-config').classList.add('hidden');
  $('join-config').classList.add('hidden');
  setStatus('');
  
  showScreen('connection');
}

// ============ Event Listeners ============
document.addEventListener('DOMContentLoaded', () => {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('Service Worker registered'))
      .catch(err => console.error('SW registration failed:', err));
  }
  
  // Connection screen
  $('btn-offline').addEventListener('click', startOfflineGame);
  
  $('btn-create-room').addEventListener('click', () => {
    $('room-config').classList.toggle('hidden');
    $('join-config').classList.add('hidden');
  });
  
  $('btn-join-room').addEventListener('click', () => {
    $('join-config').classList.toggle('hidden');
    $('room-config').classList.add('hidden');
  });
  
  $('btn-start-host').addEventListener('click', createRoom);
  $('btn-connect').addEventListener('click', joinRoom);
  
  // Lobby
  $('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(state.roomCode);
    notify('Code copied!', 'success');
  });
  
  $('btn-start-game').addEventListener('click', startMultiplayerGame);
  $('btn-leave-lobby').addEventListener('click', resetToMenu);
  
  // Game
  $('draw-pile').addEventListener('click', handleDraw);
  $('btn-draw').addEventListener('click', handleDraw);
  $('btn-uno').addEventListener('click', callUno);
  
  // Color picker
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      hideColorPicker();
      
      if (state.selectedCardIndex !== null) {
        playCard(state.selectedCardIndex, color);
      }
    });
  });
  
  // Menu
  $('btn-menu').addEventListener('click', () => {
    $('game-menu').classList.remove('hidden');
  });
  
  $('btn-resume').addEventListener('click', () => {
    $('game-menu').classList.add('hidden');
  });
  
  $('btn-quit-game').addEventListener('click', () => {
    $('game-menu').classList.add('hidden');
    resetToMenu();
  });
  
  // Game over
  $('btn-play-again').addEventListener('click', () => {
    if (state.mode === 'offline') {
      startOfflineGame();
    } else if (state.mode === 'host') {
      startMultiplayerGame();
    }
  });
  
  $('btn-main-menu').addEventListener('click', resetToMenu);
  
  // Chat
  $('chat-header').addEventListener('click', () => {
    $('chat-container').classList.toggle('minimized');
  });
  
  $('btn-chat-toggle').addEventListener('click', () => {
    $('chat-container').classList.toggle('hidden');
  });
  
  $('btn-send-chat').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  
  // Enter key for room code
  $('room-code').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
});

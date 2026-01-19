// --- KONFIGURACJA I ZMIENNE GLOBALNE ---
let peer = null;
let conn = null; // Dla klienta: połączenie z hostem
let connections = []; // Dla hosta: lista połączeń
let myId = null;
let myNick = "";
let isHost = false;
let gameSettings = { maxPlayers: 4, turnTime: 15 };

// Stan gry
let gameState = {
    players: [], // {id, nick, lives, peerId}
    activePlayerIndex: 0,
    phase: 'lobby', // 'lobby', 'choice', 'word'
    currentLetter: '',
    usedWords: [],
    timerStart: 0
};

let localTimerInterval = null;
let currentAttempts = 5;

// Prosty słownik offline (fallback) + miejsce na pełny słownik
let dictionarySet = new Set(["KROWA", "KOT", "PIES", "AUTO", "DOM", "KOSMOS", "ATLAS", "SOK", "KREM", "MAPA", "AEROPLAN", "NOGA", "AMORKI", "IGŁA", "ARBUZ", "ZEGAR", "RZEKA", "KORAL", "LAMPA"]);
// Próba załadowania dużego słownika (SJP - ok. 3MB)
fetch('https://raw.githubusercontent.com/mode89/sjp-json/master/slowa.txt') // Przykładowy URL do raw txt
    .then(r => r.text())
    .then(text => {
        const words = text.split(/\r?\n/);
        words.forEach(w => dictionarySet.add(w.toUpperCase()));
        console.log("Słownik załadowany:", dictionarySet.size, "słów");
    })
    .catch(e => console.log("Korzystam z małego słownika offline."));

// --- NAWIGACJA UI ---
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// --- PEERJS LOGIKA SIECIOWA ---
function initPeer() {
    myNick = document.getElementById('my-nick').value || "Gracz" + Math.floor(Math.random()*1000);
    peer = new Peer(null, { debug: 1 }); // Używa domyślnego serwera chmury PeerJS

    peer.on('open', (id) => {
        myId = id;
        if(isHost) {
            setupLobbyAsHost();
        } else {
            connectToHost();
        }
    });

    peer.on('connection', (c) => {
        if(isHost) handleIncomingConnection(c);
    });
}

// --- LOGIKA HOSTA ---
function createGame() {
    isHost = true;
    initPeer();
}

function setupLobbyAsHost() {
    showScreen('screen-lobby');
    document.getElementById('display-id').innerText = myId;
    document.getElementById('start-btn').classList.remove('hidden');
    document.getElementById('host-controls').classList.remove('hidden');
    
    // Dodaj siebie do graczy
    gameState.players.push({ id: myId, nick: myNick, lives: 3, peerId: myId });
    updateLobbyUI();
}

function handleIncomingConnection(c) {
    if(gameState.players.length >= gameSettings.maxPlayers || gameState.phase !== 'lobby') {
        c.send({type: 'ERROR', msg: 'Lobby pełne lub gra trwa'});
        setTimeout(() => c.close(), 500);
        return;
    }

    c.on('data', (data) => {
        if(data.type === 'JOIN') {
            const newPlayer = { id: c.peer, nick: data.nick, lives: 3, peerId: c.peer };
            gameState.players.push(newPlayer);
            connections.push(c);
            broadcastState(); // Wyślij aktualny stan do wszystkich
        }
        if(data.type === 'GAME_ACTION') handleGameAction(data, c.peer);
    });
}

function updateSettings() {
    gameSettings.maxPlayers = parseInt(document.getElementById('max-players-range').value);
    document.getElementById('max-players-val').innerText = gameSettings.maxPlayers;
}

function startGame() {
    if(gameState.players.length < 2) {
        alert("Potrzeba min. 2 graczy!");
        return;
    }
    // Rozpocznij grę: Host (Indeks 0) wybiera literę
    gameState.phase = 'choice';
    gameState.activePlayerIndex = 0;
    
    // Generuj 4 litery
    const allowed = "ABCDEFGHIJKLMNOPRSTUWYZ";
    const options = [];
    for(let i=0; i<4; i++) options.push(allowed[Math.floor(Math.random() * allowed.length)]);
    
    broadcast({ type: 'START_GAME', options: options });
}

// --- LOGIKA KLIENTA ---
function showJoinInput() {
    document.getElementById('join-area').classList.remove('hidden');
}

function joinGame() {
    isHost = false;
    initPeer();
}

function connectToHost() {
    const hostId = document.getElementById('join-id').value;
    conn = peer.connect(hostId);

    conn.on('open', () => {
        showScreen('screen-lobby');
        conn.send({ type: 'JOIN', nick: myNick });
    });

    conn.on('data', (data) => {
        handleServerData(data);
    });
    
    conn.on('close', () => alert("Rozłączono z hostem"));
}

// --- SYNCHRONIZACJA I OBSŁUGA DANYCH ---
function broadcast(msg) {
    handleServerData(msg); // Host też przetwarza wiadomość
    connections.forEach(c => c.send(msg));
}

function broadcastState() {
    broadcast({ type: 'UPDATE_STATE', state: gameState });
}

function handleServerData(data) {
    if(data.type === 'UPDATE_STATE') {
        gameState = data.state;
        updateLobbyUI();
        updateGameUI();
    }
    else if(data.type === 'START_GAME') {
        gameState.phase = 'choice';
        showScreen('screen-game');
        if(amIActive()) showLetterChoice(data.options);
        else setStatusMsg(`Gracz ${getCurrentPlayer().nick} wybiera literę...`);
        updateGameUI();
    }
    else if(data.type === 'NEXT_TURN') {
        gameState.phase = 'word';
        gameState.currentLetter = data.letter;
        gameState.activePlayerIndex = data.nextIndex;
        startTurnTimer();
        updateGameUI();
    }
    else if(data.type === 'PLAYER_ELIMINATED') {
        addToLog(`${data.nick} odpada z gry!`);
    }
    else if(data.type === 'GAME_OVER') {
        alert(`Koniec gry! Wygrał: ${data.winner}`);
        location.reload();
    }
}

// --- LOGIKA ROZGRYWKI (HOST) ---
function handleGameAction(data, senderId) {
    // Weryfikacja czy to tura nadawcy
    const activePlayer = gameState.players[gameState.activePlayerIndex];
    if(activePlayer.peerId !== senderId) return;

    if(data.action === 'CHOOSE_LETTER') {
        // Gracz 1 wybrał literę. Przekaż turę do gracza 2.
        const nextIdx = (gameState.activePlayerIndex + 1) % gameState.players.length;
        gameState.currentLetter = data.letter; // Ustaw literę
        gameState.phase = 'word';
        
        broadcast({ 
            type: 'NEXT_TURN', 
            letter: data.letter, 
            nextIndex: nextIdx 
        });
    }
    
    if(data.action === 'SUBMIT_WORD') {
        const word = data.word.toUpperCase();
        
        // Weryfikacja
        const isValid = validateWord(word);
        
        if(isValid) {
            gameState.usedWords.push(word);
            const lastChar = word.slice(-1); // Ostatnia litera
            const nextIdx = (gameState.activePlayerIndex + 1) % gameState.players.length;
            
            // Znajdź następnego żywego gracza
            let checked = 0;
            let targetIdx = nextIdx;
            while(gameState.players[targetIdx].lives <= 0 && checked < gameState.players.length) {
                targetIdx = (targetIdx + 1) % gameState.players.length;
                checked++;
            }

            broadcast({
                type: 'NEXT_TURN',
                letter: lastChar,
                nextIndex: targetIdx
            });
        } else {
             // Host wysyła info o błędzie do konkretnego gracza (lub broadcastuje fail)
             // W tym uproszczeniu: klient sam obsługuje liczbę prób, host tylko ufa lub 
             // w pełnej wersji: host zarządza życiami. Tutaj zaufamy klientowi dla płynności P2P.
        }
    }
    
    if(data.action === 'LOSE_LIFE') {
        const pIndex = gameState.players.findIndex(p => p.peerId === senderId);
        if(pIndex !== -1) {
            gameState.players[pIndex].lives--;
            if(gameState.players[pIndex].lives <= 0) {
                broadcast({ type: 'PLAYER_ELIMINATED', nick: gameState.players[pIndex].nick });
            }
            
            // Sprawdź czy koniec gry (został 1)
            const alive = gameState.players.filter(p => p.lives > 0);
            if(alive.length === 1) {
                broadcast({ type: 'GAME_OVER', winner: alive[0].nick });
                return;
            }

            // Następna tura (ten sam gracz traci życie, ale tura przechodzi dalej, czy powtarza?)
            // Zasada: traci życie, tura przechodzi.
            let nextIdx = (gameState.activePlayerIndex + 1) % gameState.players.length;
             while(gameState.players[nextIdx].lives <= 0) {
                nextIdx = (nextIdx + 1) % gameState.players.length;
            }
            
            // Litera pozostaje ta sama, bo słowo nie padło!
            broadcast({
                type: 'NEXT_TURN',
                letter: gameState.currentLetter,
                nextIndex: nextIdx
            });
        }
    }
}

// --- LOGIKA ROZGRYWKI (LOKALNA/KLIENT) ---
function validateWord(word) {
    if(!word.startsWith(gameState.currentLetter)) return false;
    if(gameState.usedWords.includes(word)) return false;
    if(!dictionarySet.has(word)) return false;
    return true;
}

function startTurnTimer() {
    clearInterval(localTimerInterval);
    currentAttempts = 5;
    updateAttemptsUI();
    
    const isMe = amIActive();
    const input = document.getElementById('word-input');
    
    if(isMe) {
        input.disabled = false;
        input.value = '';
        input.focus();
    } else {
        input.disabled = true;
        input.value = '';
    }

    let timeLeft = gameSettings.turnTime;
    updateTimerUI(timeLeft);

    localTimerInterval = setInterval(() => {
        timeLeft--;
        updateTimerUI(timeLeft);
        
        if(timeLeft <= 0) {
            clearInterval(localTimerInterval);
            if(isHost && isMe) handleTimeout(); // Jeśli host gra, sam sobie robi timeout
            else if(isMe) sendAction({ action: 'LOSE_LIFE' });
        }
    }, 1000);
}

// Input listener
document.getElementById('word-input').addEventListener('keypress', (e) => {
    if(e.key === 'Enter' && amIActive()) {
        const word = e.target.value.trim().toUpperCase();
        if(validateWord(word)) {
            sendAction({ action: 'SUBMIT_WORD', word: word });
            e.target.value = '';
        } else {
            currentAttempts--;
            updateAttemptsUI();
            e.target.classList.add('shake');
            setTimeout(()=>e.target.classList.remove('shake'), 500);
            
            if(currentAttempts <= 0) {
                sendAction({ action: 'LOSE_LIFE' });
            }
        }
    }
});

function sendAction(data) {
    if(isHost) handleGameAction(data, myId);
    else conn.send({ type: 'GAME_ACTION', ...data });
}

// --- UI HELPERS ---
function updateLobbyUI() {
    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    gameState.players.forEach(p => {
        const li = document.createElement('li');
        li.innerText = `${p.nick} ${p.id === myId ? '(TY)' : ''}`;
        list.appendChild(li);
    });
}

function updateGameUI() {
    const activeP = getCurrentPlayer();
    document.getElementById('current-player-name').innerText = `Tura: ${activeP.nick}`;
    
    // Pokaż swoje życia
    const me = gameState.players.find(p => p.id === myId);
    if(me) {
        document.getElementById('current-lives').innerText = "❤️".repeat(me.lives);
    }

    if(gameState.phase === 'word') {
        document.getElementById('phase-choice').classList.add('hidden');
        document.getElementById('phase-word').classList.remove('hidden');
        document.getElementById('required-letter').innerText = gameState.currentLetter;
    }
}

function showLetterChoice(chars) {
    const container = document.getElementById('letters-options');
    container.innerHTML = '';
    document.getElementById('phase-choice').classList.remove('hidden');
    document.getElementById('phase-word').classList.add('hidden');
    
    chars.forEach(char => {
        const div = document.createElement('div');
        div.className = 'letter-card';
        div.innerText = char;
        div.onclick = () => sendAction({ action: 'CHOOSE_LETTER', letter: char });
        container.appendChild(div);
    });
}

function updateTimerUI(val) {
    document.getElementById('timer-text').innerText = val;
    const offset = 100 - (val / 15) * 100;
    document.getElementById('timer-path').style.strokeDashoffset = offset;
}

function updateAttemptsUI() {
    const spans = document.querySelectorAll('#attempts-bar span');
    spans.forEach((s, i) => {
        if(i < currentAttempts) s.classList.remove('lost');
        else s.classList.add('lost');
    });
}

function addToLog(msg) {
    const log = document.getElementById('game-log');
    const p = document.createElement('div');
    p.innerText = msg;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
}

function copyId() {
    navigator.clipboard.writeText(myId);
    alert("Skopiowano ID!");
}

// Utils
const getCurrentPlayer = () => gameState.players[gameState.activePlayerIndex];
const amIActive = () => getCurrentPlayer()?.peerId === myId;
const setStatusMsg = (txt) => document.getElementById('game-log').innerHTML = txt;

// CSS Shake animation inject
const styleSheet = document.createElement("style");
styleSheet.innerText = `
.shake { animation: shake 0.5s; border-color: red !important; }
@keyframes shake { 0% { transform: translate(1px, 1px) rotate(0deg); } 10% { transform: translate(-1px, -2px) rotate(-1deg); } 20% { transform: translate(-3px, 0px) rotate(1deg); } 30% { transform: translate(3px, 2px) rotate(0deg); } 40% { transform: translate(1px, -1px) rotate(1deg); } 50% { transform: translate(-1px, 2px) rotate(-1deg); } 60% { transform: translate(-3px, 1px) rotate(0deg); } 70% { transform: translate(3px, 1px) rotate(-1deg); } 80% { transform: translate(-1px, -1px) rotate(1deg); } 90% { transform: translate(1px, 2px) rotate(0deg); } 100% { transform: translate(1px, -2px) rotate(-1deg); } }
`;
document.head.appendChild(styleSheet);

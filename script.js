class SudokuGame {
    constructor() {
        this.grid = Array(9).fill().map(() => Array(9).fill(0));
        this.solution = Array(9).fill().map(() => Array(9).fill(0));
        this.mistakes = 0;
        this.maxMistakes = 3;
        this.difficulty = "Easy";
        this.startTime = Date.now();
        this.timerRunning = true;

        this.gameMode = "single";
        this.isMultiplayer = false;
        this.currentPlayer = 1;
        this.player1Mistakes = 0;
        this.player2Mistakes = 0;
        this.playerNum = null;

        this.player1Time = 0;
        this.player2Time = 0;
        this._lastTimerUpdate = Date.now();

        this.ws = null;

        this.spotifyConnected = false;
        this.currentSong = "No song playing";
        this.isMusicPlaying = false;
        this.currentTrackId = null;
        this.trackTempo = 120;
        this.trackEnergy = 0.5;
        this.songStartTime = 0;
        this.spotifyCheckInterval = null;
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 3;

        this.soundWaves = Array(50).fill().map(() => Math.random() * 0.5 + 0.3);
        this.waveAnimationRunning = true;

        this.difficultySettings = {
            "Easy": 35,
            "Medium": 45,
            "Hard": 55,
            "Stupidly Hard": 60,
            "Impossibly Hard": 70
        };

        this._notifTimeout = null;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.generatePuzzle();
        this.updateTimer();
        this.animateWaves();
        this.checkThemeChange();
        this.checkSpotifyStatus();
        if (this.isMultiplayer) {
            this.initWebSocket();
        }
        
        // Initialize song display
        this.updateSongDisplay();
    }

    setupEventListeners() {
        document.querySelectorAll('.cell').forEach(cell => {
            cell.addEventListener('input', (e) => this.validateInput(e));
            cell.addEventListener('click', (e) => this.onCellClick(e));
            cell.addEventListener('keydown', (e) => this.onKeyDown(e));
        });

        const modeSelect = document.getElementById('mode-select');
        if (modeSelect) {
            modeSelect.addEventListener('change', (e) => {
                this.changeMode(e.target.value);
            });
        }

        const diffSelect = document.getElementById('difficulty-select');
        if (diffSelect) {
            diffSelect.addEventListener('change', (e) => {
                this.changeDifficulty(e.target.value);
            });
        }

        this.setupDropdownListeners();
    }

    showNotification(message) {
        const box = document.getElementById('notification-box');
        if (box) {
            box.textContent = message;
            box.style.opacity = 0.95;
            clearTimeout(this._notifTimeout);
            this._notifTimeout = setTimeout(() => {
                box.style.opacity = 0.7;
            }, 5000);
        }
    }

    setPlayerIdentity() {
        const label = document.getElementById('player-identity');
        if (label) {
            if (this.isMultiplayer && this.playerNum) {
                label.textContent = `You are Player ${this.playerNum}`;
                label.style.color = this.playerNum === 1 ? '#2196f3' : '#43a047'; // blue for 1, green for 2
                //label.style.color = '#fff';
            } else {
                label.textContent = '';
                label.style.background = '';
                label.style.color = '';
            }
        }
    }

    initWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${protocol}://${location.host}`);
        this.ws.onopen = () => {
            // Send selected difficulty to server
            const diffSelect = document.getElementById('difficulty-select');
            const difficulty = diffSelect ? diffSelect.value : "Easy";
            this.ws.send(JSON.stringify({
                type: 'join',
                difficulty: difficulty
            }));
        };
        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'init') {
                this.grid = data.grid;
                this.solution = data.solution;
                this.player1Mistakes = data.mistakes[0];
                this.player2Mistakes = data.mistakes[1];
                this.currentPlayer = data.currentPlayer;
                this.playerNum = data.playerNum;
                this.player1Time = 0;
                this.player2Time = 0;
                this._lastTimerUpdate = Date.now();
                this.timerRunning = true; // Start timer now
                this.updateDisplay();
                this.updateMultiplayerDisplay();
                this.setPlayerIdentity();
                if (data.notify) {
                    this.showNotification(`Both players are connected! Game starts now. You are Player ${this.playerNum}.`);
                } else {
                    this.showNotification(`You are Player ${this.playerNum}. Waiting for another player...`);
                }
            }
            if (data.type === 'waiting') {
                this.showNotification(data.message);
            }
            if (data.type === 'move') {
                const { row, col, value, player } = data.move;
                const cell = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
                if (cell) {
                    cell.value = value;
                    cell.classList.remove('wrong', 'empty', 'player1', 'player2');
                    cell.classList.add(player === 1 ? 'player1' : 'player2');
                    cell.disabled = true;
                }
                this.currentPlayer = data.currentPlayer;
                this._lastTimerUpdate = Date.now();
                this.updateMultiplayerDisplay();

                // Show notifications for both players
                if (this.playerNum === player) {
                    this.showNotification(`Great job! It is now Player ${this.currentPlayer}'s turn.`);
                } else if (this.playerNum === this.currentPlayer) {
                    this.showNotification("It is now your turn!");
                }
            }
            if (data.type === 'mistake') {
                this.player1Mistakes = data.mistakes[0];
                this.player2Mistakes = data.mistakes[1];
                this.currentPlayer = data.currentPlayer;
                this._lastTimerUpdate = Date.now();
                this.updateMultiplayerDisplay();
                if (data.cell) {
                    const cell = document.querySelector(`.cell[data-row="${data.cell.row}"][data-col="${data.cell.col}"]`);
                    if (cell) {
                        cell.classList.add('wrong');
                        cell.value = data.wrongValue || '';
                    }
                    if (this.playerNum === data.player) {
                        this.showNotification(`You made a mistake at (${data.cell.row + 1}, ${data.cell.col + 1}). You can change the number on your next turn.`);
                    } else {
                        this.showNotification(`Player ${data.player} made a mistake at (${data.cell.row + 1}, ${data.cell.col + 1}). It is now your turn (you can change their number if you want).`);
                    }
                }
            }
            if (data.type === 'gameover') {
                this.endMultiplayerGame();
            }
        };
    }

    validateInput(event) {
        const cell = event.target;
        let value = cell.value;

        if (value.length > 1) {
            value = value.slice(-1);
            cell.value = value;
        }

        if (value && (!/^[1-9]$/.test(value))) {
            cell.value = '';
            return;
        }

        if (value) {
            setTimeout(() => this.checkNumber(cell), 0);
        }
    }

    onCellClick(event) {
        const cell = event.target;
        if (cell.disabled) return;
        if (cell.classList.contains('wrong')) {
            cell.value = '';
            cell.classList.remove('wrong');
            cell.classList.add('empty');
        }
    }

    onKeyDown(event) {
        const cell = event.target;
        if (cell.disabled) return;
        if (event.key === 'Backspace' && cell.classList.contains('wrong')) {
            cell.value = '';
            cell.classList.remove('wrong');
            cell.classList.add('empty');
        }
    }

    checkNumber(cell) {
        const row = parseInt(cell.dataset.row);
        const col = parseInt(cell.dataset.col);
        const value = parseInt(cell.value);

        if (this.isMultiplayer && this.ws) {
            if (this.playerNum !== this.currentPlayer) {
                this.showNotification("It's not your turn!");
                cell.value = '';
                return;
            }
            const currentMistakes = this.playerNum === 1 ? this.player1Mistakes : this.player2Mistakes;
            if (currentMistakes >= this.maxMistakes) return;
        } else {
            if (this.mistakes >= this.maxMistakes) return;
        }

        if (!value || cell.classList.contains('prefilled')) {
            return;
        }

        if (value === this.solution[row][col]) {
            cell.classList.remove('wrong', 'empty');
            if (this.isMultiplayer && this.ws) {
                cell.classList.add(this.playerNum === 1 ? 'player1' : 'player2');
                cell.disabled = true;
                this.ws.send(JSON.stringify({
                    type: 'move',
                    move: { row, col, value, player: this.playerNum }
                }));
            } else {
                cell.classList.add('correct');
                cell.disabled = true;
            }
            this.checkSolution();
        } else {
            cell.classList.remove('empty', 'correct', 'player1', 'player2');
            cell.classList.add('wrong');
            if (this.isMultiplayer && this.ws) {
                this.ws.send(JSON.stringify({
                    type: 'mistake',
                    player: this.playerNum,
                    cell: { row, col },
                    wrongValue: value
                }));
                this.updateMultiplayerDisplay();
            } else {
                this.mistakes++;
                this.updateMistakeDisplay();
                if (this.mistakes >= this.maxMistakes) {
                    this.timerRunning = false;
                    this.showNotification("3 mistakes! Game over");
                    this.newGame();
                }
            }
        }
    }

    isValid(grid, row, col, num) {
        for (let j = 0; j < 9; j++) {
            if (grid[row][j] === num) return false;
        }
        for (let i = 0; i < 9; i++) {
            if (grid[i][col] === num) return false;
        }
        const startRow = Math.floor(row / 3) * 3;
        const startCol = Math.floor(col / 3) * 3;
        for (let i = startRow; i < startRow + 3; i++) {
            for (let j = startCol; j < startCol + 3; j++) {
                if (grid[i][j] === num) return false;
            }
        }
        return true;
    }

    fillGrid() {
        for (let i = 0; i < 9; i++) {
            for (let j = 0; j < 9; j++) {
                if (this.grid[i][j] === 0) {
                    const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
                    this.shuffleArray(numbers);
                    for (const num of numbers) {
                        if (this.isValid(this.grid, i, j, num)) {
                            this.grid[i][j] = num;
                            if (this.fillGrid()) {
                                return true;
                            }
                            this.grid[i][j] = 0;
                        }
                    }
                    return false;
                }
            }
        }
        return true;
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    generatePuzzle() {
        this.mistakes = 0;
        this.player1Mistakes = 0;
        this.player2Mistakes = 0;
        this.currentPlayer = 1;
        this.startTime = Date.now();
        this.timerRunning = true;
        this.player1Time = 0;
        this.player2Time = 0;
        this._lastTimerUpdate = Date.now();
        this.grid = Array(9).fill().map(() => Array(9).fill(0));
        this.fillGrid();
        this.solution = this.grid.map(row => [...row]);
        const cellsToRemove = this.difficultySettings[this.difficulty];
        this.removeCells(cellsToRemove);
        this.updateDisplay();
        this.updateMistakeDisplay();
        if (this.isMultiplayer) {
            this.updateMultiplayerDisplay();
        }
    }

    removeCells(count) {
        const positions = [];
        for (let i = 0; i < 9; i++) {
            for (let j = 0; j < 9; j++) {
                positions.push([i, j]);
            }
        }
        this.shuffleArray(positions);
        for (let i = 0; i < Math.min(count, positions.length); i++) {
            const [row, col] = positions[i];
            this.grid[row][col] = 0;
        }
    }

    updateDisplay() {
        const cells = document.querySelectorAll('.cell');
        cells.forEach(cell => {
            const row = parseInt(cell.dataset.row);
            const col = parseInt(cell.dataset.col);
            const value = this.grid[row][col];
            cell.value = value || '';
            cell.disabled = false;
            cell.classList.remove('prefilled', 'correct', 'wrong', 'player1', 'player2', 'empty');
            if (value !== 0) {
                cell.classList.add('prefilled');
                cell.disabled = true;
            } else {
                cell.classList.add('empty');
            }
        });
    }

    updateMistakeDisplay() {
        const mistakesLabel = document.getElementById('mistakes');
        if (mistakesLabel) {
            mistakesLabel.textContent = `Mistakes: ${this.mistakes}`;
        }
    }

    updateMultiplayerDisplay() {
        const mistakesLabel = document.getElementById('mistakes');
        if (mistakesLabel) {
            mistakesLabel.textContent =
                `Player 1: ${this.player1Mistakes}/${this.maxMistakes} mistakes | Player 2: ${this.player2Mistakes}/${this.maxMistakes} mistakes`;
        }
        const playerLabel = document.getElementById('player-turn');
        if (playerLabel) {
            const playerColor = this.currentPlayer === 1 ? 'var(--player1-color)' : 'var(--player2-color)';
            playerLabel.textContent = `Player ${this.currentPlayer}'s Turn`;
            playerLabel.style.color = playerColor;
        }
        // Disable board if it's not your turn
        if (this.isMultiplayer && this.playerNum !== this.currentPlayer) {
            this.setBoardEnabled(false);
        } else {
            this.setBoardEnabled(true);
        }
    }

    setBoardEnabled(enabled) {
        const cells = document.querySelectorAll('.cell');
        cells.forEach(cell => {
            cell.disabled = !enabled || cell.classList.contains('prefilled');
        });
    }

    switchPlayer() {
        if (!this.isMultiplayer) return;
        this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
        this.updateMultiplayerDisplay();
    }

    changeMode(mode) {
        this.gameMode = mode;
        this.isMultiplayer = (mode === "multiplayer");
        if(!this.isMultiplayer) {
            this.maxMistakes = 10000000;
        }
        const diffSelect = document.getElementById('difficulty-select');
        if (diffSelect) {
            diffSelect.disabled = this.isMultiplayer;
        }
        // Reset timers and pause timer
        this.player1Time = 0;
        this.player2Time = 0;
        this.timerRunning = false; // <--- PAUSE TIMER
        this._lastTimerUpdate = Date.now();
        if (this.isMultiplayer) {
            this.initWebSocket();
        }
        this.newGame();
            // Reset multiplayer UI and state when switching to singleplayer
            if (!this.isMultiplayer) {
                // Hide waiting for player notification
                const notifBox = document.getElementById('notification-box');
                if (notifBox) notifBox.textContent = '';
                // Clear player identity label
                const playerIdentity = document.getElementById('player-identity');
                if (playerIdentity) {
                    playerIdentity.textContent = '';
                    playerIdentity.style.color = '';
                    playerIdentity.style.background = '';
                }
                // Clear player turn label
                const playerTurn = document.getElementById('player-turn');
                if (playerTurn) {
                    playerTurn.textContent = '';
                    playerTurn.style.color = '';
                }
                // Reset multiplayer state variables
                this.playerNum = null;
                this.player1Mistakes = 0;
                this.player2Mistakes = 0;
                this.currentPlayer = 1;
                if (this.ws) {
                    this.ws.close();
                    this.ws = null;
                }
            }
    }
    changeDifficulty(difficulty) {
        this.difficulty = difficulty;
        this.newGame();
    }

    newGame() {
        this.generatePuzzle();
    }

    updateTimer() {
        const timerLabel = document.getElementById('timer');
        const now = Date.now();
        if (this.timerRunning && timerLabel) {
            if (this.isMultiplayer) {
                const delta = Math.floor((now - this._lastTimerUpdate) / 1000);
                if (delta > 0) {
                    if (this.currentPlayer === 1) {
                        this.player1Time += delta;
                    } else {
                        this.player2Time += delta;
                    }
                    this._lastTimerUpdate = now;
                }
                timerLabel.textContent =
                    `Player 1: ${this.formatTime(this.player1Time)} | Player 2: ${this.formatTime(this.player2Time)}`;
            } else {
                const elapsed = Math.floor((now - this.startTime) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                timerLabel.textContent =
                    `Time: ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }
        }
        setTimeout(() => this.updateTimer(), 1000);
    }

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    checkSolution() {
        const cells = document.querySelectorAll('.cell');
        const currentGrid = Array(9).fill().map(() => Array(9).fill(0));
        cells.forEach(cell => {
            const row = parseInt(cell.dataset.row);
            const col = parseInt(cell.dataset.col);
            const value = parseInt(cell.value) || 0;
            currentGrid[row][col] = value;
        });
        for (let i = 0; i < 9; i++) {
            for (let j = 0; j < 9; j++) {
                if (currentGrid[i][j] === 0) return false;
                const temp = currentGrid[i][j];
                currentGrid[i][j] = 0;
                if (!this.isValid(currentGrid, i, j, temp)) {
                    currentGrid[i][j] = temp;
                    return false;
                }
                currentGrid[i][j] = temp;
            }
        }
        this.timerRunning = false;
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        if (this.isMultiplayer) {
            this.endMultiplayerGame();
        } else {
            this.showNotification(`Congratulations! Puzzle solved in ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}!`);
            this.newGame();
        }
        return true;
    }

    endMultiplayerGame() {
        this.setBoardEnabled(false);
        this.timerRunning = false;
        let msg;
        if (this.player1Mistakes < this.player2Mistakes) {
            msg = "Game over! Player 1 wins!";
        } else if (this.player2Mistakes < this.player1Mistakes) {
            msg = "Game over! Player 2 wins!";
        } else {
            if (this.player1Time < this.player2Time) {
                msg = `Game over! Both players made the same number of mistakes, but Player 1 wins by time (${this.formatTime(this.player1Time)} vs ${this.formatTime(this.player2Time)})!`;
            } else if (this.player2Time < this.player1Time) {
                msg = `Game over! Both players made the same number of mistakes, but Player 2 wins by time (${this.formatTime(this.player2Time)} vs ${this.formatTime(this.player1Time)})!`;
            } else {
                msg = "Game over! It's a draw!";
            }
        }
        this.showNotification(msg + " New game starting in 10 seconds...");
        
        setTimeout(() => {
            this.newGame();
            this.setBoardEnabled(true);
            this.timerRunning = true;
            this.showNotification("New game started!");
        }, 10000);
    }

    async checkSpotifyStatus() {
        try {
            const response = await fetch('/spotify-status');
            const data = await response.json();
            
            if (data.connected) {
                this.spotifyConnected = true;
                this.updateSoundwaveButton('connected');
                this.startSpotifyPolling();
            } else {
                this.spotifyConnected = false;
                this.updateSoundwaveButton('disconnected');
            }
        } catch (error) {
            console.error('Failed to check Spotify status:', error);
        }
    }

    updateSoundwaveButton(state) {
        const soundwaveBtn = document.getElementById('soundwave-btn');
        if (!soundwaveBtn) return;
        
        switch (state) {
            case 'connected':
                soundwaveBtn.textContent = "Spotify Connected";
                soundwaveBtn.classList.remove('soundwaves', 'connecting');
                soundwaveBtn.classList.add('connected');
                break;
            case 'connecting':
                soundwaveBtn.textContent = "Connecting...";
                soundwaveBtn.classList.remove('soundwaves', 'connected');
                soundwaveBtn.classList.add('connecting');
                break;
            case 'soundwaves':
                soundwaveBtn.textContent = "Playing Soundwaves";
                soundwaveBtn.classList.remove('connected', 'connecting');
                soundwaveBtn.classList.add('soundwaves');
                break;
            default:
                soundwaveBtn.textContent = "Soundwave Options";
                soundwaveBtn.classList.remove('connected', 'connecting', 'soundwaves');
                break;
        }
    }

    setupDropdownListeners() {
        const connectSpotifyBtn = document.getElementById('connect-spotify');
        const playSoundwavesBtn = document.getElementById('play-soundwaves');
        
        if (connectSpotifyBtn) {
            connectSpotifyBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.connectSpotify();
            });
        }
        
        if (playSoundwavesBtn) {
            playSoundwavesBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.playSoundwaves();
            });
        }
    }

    playSoundwaves() {
        this.spotifyConnected = false;
        this.isMusicPlaying = true;
        this.currentSong = "Playing soundwaves";
        this.updateSoundwaveButton('soundwaves');
        this.updateSongDisplay();
        this.showNotification('Playing soundwaves!');
    }

    startSpotifyPolling() {
        if (this.spotifyCheckInterval) {
            clearInterval(this.spotifyCheckInterval);
        }
        this.getCurrentSong();
        this.spotifyCheckInterval = setInterval(() => {
            this.getCurrentSong();
        }, 3000);
    }

    stopSpotifyPolling() {
        if (this.spotifyCheckInterval) {
            clearInterval(this.spotifyCheckInterval);
            this.spotifyCheckInterval = null;
        }
    }

    connectSpotify() {
        if (this.spotifyConnected) {
            this.showNotification('Spotify is already connected and working!');
            return;
        }

        this.updateSoundwaveButton('connecting');
        
        // Try direct connection first (proxy mode)
        this.getCurrentSong().then(() => {
            if (this.currentSong && this.currentSong !== 'No song playing' && this.currentSong !== 'Connection error') {
                this.spotifyConnected = true;
                this.updateSoundwaveButton('connected');
                this.startSpotifyPolling();
                this.showNotification('Connected via proxy!');
                return;
            }
            
            // Fallback to OAuth if proxy fails
            this.connectionAttempts++;
            const authWindow = window.open('/spotify-auth', 'spotify-auth',
                'width=500,height=600,scrollbars=yes,resizable=yes');
            
            const messageHandler = (event) => {
                if (event.data && event.data.type === 'spotify-connected') {
                    window.removeEventListener('message', messageHandler);
                    if (event.data.success) {
                        this.spotifyConnected = true;
                        this.connectionAttempts = 0;
                        this.updateSoundwaveButton('connected');
                        this.startSpotifyPolling();
                        this.showNotification('Spotify connected successfully!');
                    } else {
                        this.updateSoundwaveButton('disconnected');
                        this.showNotification('Failed to connect to Spotify');
                    }
                }
            };
            
            window.addEventListener('message', messageHandler);
            
            if (!authWindow) {
                this.updateSoundwaveButton('disconnected');
                this.showNotification('Please allow popups for this site to connect to Spotify');
                return;
            }
            
            const checkClosed = setInterval(() => {
                if (authWindow.closed) {
                    clearInterval(checkClosed);
                    window.removeEventListener('message', messageHandler);
                    if (!this.spotifyConnected) {
                        this.updateSoundwaveButton('disconnected');
                    }
                }
            }, 1000);
        });
    }

    async getCurrentSong() {
        if (!this.spotifyConnected) return;
        
        try {
            const response = await fetch('/spotify-current-song');
            const data = await response.json();
            
            if (data.needsReauth) {
                this.handleSpotifyDisconnection();
                return;
            }
            
            if (data && data.item) {
                const track = data.item;
                const artist = track.artists[0].name;
                const song = track.name;
                const trackId = track.id;
                this.isMusicPlaying = data.is_playing;
                
                if (trackId !== this.currentTrackId) {
                    this.currentTrackId = trackId;
                    this.trackTempo = Math.random() * 60 + 90; // 90-150 BPM
                    this.trackEnergy = Math.random() * 0.4 + 0.4; // 0.4-0.8
                }
                
                if (data.isFreeAccount) {
                    this.currentSong = `${artist} - ${song} (Recently played)`;
                    this.isMusicPlaying = false; // Show as not currently playing
                } else if (this.isMusicPlaying) {
                    const progressMs = data.progress_ms || 0;
                    this.songStartTime = Date.now() - progressMs;
                    this.currentSong = `${artist} - ${song}`;
                } else {
                    this.currentSong = `${artist} - ${song} (Paused)`;
                }
            } else if (data && data.isConnected && data.userProfile) {
                this.currentSong = `Connected as ${data.userProfile.display_name || data.userProfile.id}`;
                this.isMusicPlaying = false;
            } else if (data && data.needsUserAccess) {
                this.currentSong = "Sorry You are Not Added. We will display the soundwaves for you though.";
                this.isMusicPlaying = true;
            } else if (data && data.requiresPremium) {
                this.currentSong = "Spotify Premium required";
                this.isMusicPlaying = false;
            } else if (data && data.message) {
                this.currentSong = data.message;
                this.isMusicPlaying = false;
            } else {
                this.currentSong = "No song playing";
                this.isMusicPlaying = false;
            }
            
            this.updateSongDisplay();
            
        } catch (error) {
            console.error('Spotify API error:', error);
            const response = await fetch('/spotify-current-song').catch(() => null);
            if (response && response.status === 401) {
                this.handleSpotifyDisconnection();
            } else {
                this.currentSong = "Connection error";
                this.isMusicPlaying = false;
                this.updateSongDisplay();
            }
        }
    }
    
    updateSongDisplay() {
        const songInfo = document.getElementById('song-info');
        const canvas = document.getElementById('wave-canvas');
        
        if (songInfo) {
            songInfo.textContent = this.currentSong;
            if (this.isMusicPlaying) {
                songInfo.classList.add('playing');
            } else {
                songInfo.classList.remove('playing');
            }
        }
        
        if (canvas) {
            if (this.isMusicPlaying) {
                canvas.classList.add('active');
            } else {
                canvas.classList.remove('active');
            }
        }
    }
    
    handleSpotifyDisconnection() {
        this.spotifyConnected = false;
        this.currentSong = "Discord disconnected";
        this.isMusicPlaying = false;
        this.stopSpotifyPolling();
        this.updateSoundwaveButton('disconnected');
        this.updateSongDisplay();
        
        if (this.connectionAttempts < this.maxConnectionAttempts) {
            this.showNotification('Discord connection lost. Click to reconnect.');
        }
    }

    animateWaves() {
        if (!this.waveAnimationRunning) return;
        const canvas = document.getElementById('wave-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        const waveColor = getComputedStyle(document.documentElement).getPropertyValue('--wave-color');
        const barWidth = canvasWidth / this.soundWaves.length;
        
        for (let i = 0; i < this.soundWaves.length; i++) {
            const x = i * barWidth;
            const waveHeight = Math.max(6, this.soundWaves[i] * (canvasHeight - 8));
            const centerY = canvasHeight / 2;
            
            // Create gradient effect for active music
            if (this.isMusicPlaying) {
                if (this.spotifyConnected) {
                    const gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
                    gradient.addColorStop(0, '#1db954');
                    gradient.addColorStop(1, waveColor);
                    ctx.fillStyle = gradient;
                } else {
                    // Soundwave mode - cyan/blue gradient like the image
                    const gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
                    gradient.addColorStop(0, '#00ffff');
                    gradient.addColorStop(0.5, '#0080ff');
                    gradient.addColorStop(1, '#004080');
                    ctx.fillStyle = gradient;
                }
            } else {
                ctx.fillStyle = waveColor;
            }
            
            ctx.fillRect(
                x + 1.5,
                centerY - waveHeight / 2,
                barWidth - 3,
                waveHeight
            );
        }
        
        if (this.isMusicPlaying) {
            const beatIntensity = 0.5 + 0.4 * Math.sin(Date.now() * 0.001 * (this.trackTempo / 60.0) * 2 * Math.PI);
            const energyBoost = this.trackEnergy * 0.3;
            this.soundWaves.push(Math.random() * 0.4 + beatIntensity + energyBoost);
        } else {
            this.soundWaves.push(Math.random() * 0.15 + 0.1);
        }
        this.soundWaves.shift();
        setTimeout(() => this.animateWaves(), this.isMusicPlaying ? 80 : 150);
    }

    checkThemeChange() {
        setTimeout(() => this.checkThemeChange(), 2000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new SudokuGame();
});

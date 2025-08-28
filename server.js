require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

let spotifyTokens = {};

function loadCachedTokens() {
    try {
        const cachePath = require('os').homedir() + '/.spotify_cache';
        if (fs.existsSync(cachePath)) {
            const cacheData = fs.readFileSync(cachePath, 'utf8');
            const tokens = JSON.parse(cacheData);
            if (tokens.access_token) {
                spotifyTokens = tokens;
                return true;
            }
        }
    } catch (error) {
        console.log('No cached tokens found');
    }
    return false;
}

function saveCachedTokens(tokens) {
    try {
        const cachePath = require('os').homedir() + '/.spotify_cache';
        fs.writeFileSync(cachePath, JSON.stringify(tokens));
        console.log('Saved Spotify tokens to cache');
    } catch (error) {
        console.error('Failed to save tokens to cache:', error);
    }
}

function getSpotifyAuthUrl() {
    const state = Math.random().toString(36).substring(7);
    const scope = 'user-read-currently-playing user-read-playback-state';
    const params = {
        client_id: SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: SPOTIFY_REDIRECT_URI,
        state: state,
        scope: scope
    };
    return `https://accounts.spotify.com/authorize?${querystring.stringify(params)}`;
}

function exchangeCodeForToken(code) {
    return new Promise((resolve, reject) => {
        const postData = querystring.stringify({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: SPOTIFY_REDIRECT_URI
        });

        const options = {
            hostname: 'accounts.spotify.com',
            path: '/api/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const tokenData = JSON.parse(data);
                    if (tokenData.access_token) {
                        spotifyTokens = tokenData;
                        saveCachedTokens(tokenData);
                        resolve(tokenData);
                    } else {
                        reject(tokenData);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function refreshSpotifyToken(refreshToken) {
    return new Promise((resolve, reject) => {
        const postData = querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        });

        const options = {
            hostname: 'accounts.spotify.com',
            path: '/api/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const tokenData = JSON.parse(data);
                    if (tokenData.access_token) {
                        spotifyTokens.access_token = tokenData.access_token;
                        saveCachedTokens(spotifyTokens);
                        resolve(tokenData);
                    } else {
                        reject(tokenData);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function getCurrentPlayback(accessToken) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.spotify.com',
            path: '/v1/me/player',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const playbackData = JSON.parse(data);
                    resolve(playbackData);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// --- Multiplayer random board generation ---
function isValid(grid, row, col, num) {
    for (let x = 0; x < 9; x++) {
        if (grid[row][x] === num || grid[x][col] === num) return false;
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

function fillGrid(grid) {
    for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
            if (grid[row][col] === 0) {
                let nums = [1,2,3,4,5,6,7,8,9];
                for (let i = nums.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [nums[i], nums[j]] = [nums[j], nums[i]];
                }
                for (let num of nums) {
                    if (isValid(grid, row, col, num)) {
                        grid[row][col] = num;
                        if (fillGrid(grid)) return true;
                        grid[row][col] = 0;
                    }
                }
                return false;
            }
        }
    }
    return true;
}

function generateSudoku(difficulty = "Easy", randomize = false) {
    let grid = Array(9).fill().map(() => Array(9).fill(0));
    if (randomize) {
        fillGrid(grid);
    } else {
        for (let i = 0; i < 9; i++) {
            for (let j = 0; j < 9; j++) {
                grid[i][j] = ((i * 3 + Math.floor(i / 3) + j) % 9) + 1;
            }
        }
    }
    let solution = grid.map(row => [...row]);
    let cellsToRemove = 35;
    if (difficulty === "Medium") cellsToRemove = 45;
    if (difficulty === "Hard") cellsToRemove = 55;
    if (difficulty === "Stupidly Hard") cellsToRemove = 60;
    if (difficulty === "Impossibly Hard") cellsToRemove = 70;
    let positions = [];
    for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
            positions.push([i, j]);
        }
    }
    for (let k = 0; k < cellsToRemove; k++) {
        const idx = Math.floor(Math.random() * positions.length);
        const [row, col] = positions.splice(idx, 1)[0];
        grid[row][col] = 0;
    }
    return { grid, solution };
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    if (pathname === '/spotify-auth') {
        const authUrl = getSpotifyAuthUrl();
        res.writeHead(302, { 'Location': authUrl });
        res.end();
        return;
    }

    if (pathname === '/' && url.searchParams.has('code')) {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        
        if (code) {
            exchangeCodeForToken(code)
                .then(tokenData => {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`<script>
                        window.opener && window.opener.postMessage('spotify-connected', '*');
                        window.close();
                    </script><h1>Spotify Connected! You can close this window.</h1>`);
                })
                .catch(error => {
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end('<h1>Authorization failed</h1>');
                });
        } else {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>Authorization failed</h1>');
        }
        return;
    }

    if (pathname === '/spotify-current-song') {
        if (!spotifyTokens.access_token) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not authenticated' }));
            return;
        }

        getCurrentPlayback(spotifyTokens.access_token)
            .then(playbackData => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(playbackData));
            })
            .catch(error => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Spotify API error', details: error }));
            });
        return;
    }

    let filePath = pathname === '/' ? './index.html' : '.' + pathname;
    const extname = path.extname(filePath);
    const contentType = mimeTypes[extname] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>404 Not Found</h1>');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

// --- Multiplayer rooms logic ---
let rooms = {};
let nextRoomId = 1;

function startNewGameForRoom(roomId, difficulty) {
    const puzzle = generateSudoku(difficulty, true);
    rooms[roomId].game = {
        grid: puzzle.grid,
        solution: puzzle.solution,
        moves: [],
        mistakes: [0, 0],
        currentPlayer: 1
    };
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    // Find a room with 0 or 1 player, or create a new one
    let roomId = null;
    for (const id in rooms) {
        if (rooms[id].players.length < 2) {
            roomId = id;
            break;
        }
    }
    if (!roomId) {
        roomId = nextRoomId++;
        rooms[roomId] = { players: [], game: null };
    }

    const playerNum = rooms[roomId].players.length + 1;
    rooms[roomId].players.push(ws);

    ws.roomId = roomId;
    ws.playerNum = playerNum;

    if (rooms[roomId].players.length === 2) {
        const diff = rooms[roomId].players[0].selectedDifficulty || "Easy";
        startNewGameForRoom(roomId, diff);
        rooms[roomId].players.forEach((client, idx) => {
            client.send(JSON.stringify({
                type: 'init',
                grid: rooms[roomId].game.grid,
                solution: rooms[roomId].game.solution,
                mistakes: rooms[roomId].game.mistakes,
                currentPlayer: rooms[roomId].game.currentPlayer,
                playerNum: idx + 1,
                notify: true
            }));
        });
    } else {
        ws.send(JSON.stringify({ type: 'waiting', message: 'Waiting for another player...' }));
    }

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch { return; }
        if (data.type === 'join') {
            ws.selectedDifficulty = data.difficulty || "Easy";
        }
        const room = rooms[ws.roomId];
        if (!room || !room.game) return;

        if (data.type === 'move') {
            const { row, col, value, player } = data.move;
            room.game.grid[row][col] = value;
            room.game.moves.push(data.move);
            room.game.currentPlayer = room.game.currentPlayer === 1 ? 2 : 1;
            room.players.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'move',
                        move: data.move,
                        currentPlayer: room.game.currentPlayer
                    }));
                }
            });
        }
        if (data.type === 'mistake') {
            const idx = data.player - 1;
            room.game.mistakes[idx]++;
            room.game.currentPlayer = room.game.currentPlayer === 1 ? 2 : 1;
            room.players.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'mistake',
                        mistakes: room.game.mistakes,
                        cell: data.cell,
                        wrongValue: data.wrongValue,
                        currentPlayer: room.game.currentPlayer,
                        player: data.player
                    }));
                }
            });
            // End game if a player reaches 3 mistakes
            if (room.game.mistakes[idx] >= 3) {
                room.players.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'gameover',
                            loser: data.player
                        }));
                    }
                });
                room.game = null; // Optionally reset game state
            }
        }
    });

    ws.on('close', () => {
        const room = rooms[ws.roomId];
        if (!room) return;
        room.players = room.players.filter(client => client !== ws);
        if (room.players.length < 2) {
            room.game = null;
            room.players.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'waiting', message: 'Other player disconnected.' }));
                }
            });
        }
        // Clean up empty rooms
        if (room.players.length === 0) {
            delete rooms[ws.roomId];
        }
    });
});

server.listen(PORT, async () => {
    console.log(`Sudoku Game Server running at http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop the server');
    loadCachedTokens();
});

process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

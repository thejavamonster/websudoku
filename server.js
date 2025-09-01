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
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}`;

const sessions = new Map();

function generateSessionId() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function getSessionTokens(sessionId) {
    return sessions.get(sessionId) || null;
}

function saveSessionTokens(sessionId, tokens) {
    sessions.set(sessionId, { ...tokens, lastUsed: Date.now() });
}

function cleanupOldSessions() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    for (const [sessionId, data] of sessions.entries()) {
        if (now - data.lastUsed > maxAge) {
            sessions.delete(sessionId);
        }
    }
}

function getSpotifyAuthUrl(sessionId) {
    const scope = 'user-read-currently-playing user-read-playback-state user-read-recently-played';
    const params = {
        client_id: SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: SPOTIFY_REDIRECT_URI,
        state: sessionId,
        scope: scope,
        show_dialog: true
    };
    return `https://accounts.spotify.com/authorize?${querystring.stringify(params)}`;
}

function exchangeCodeForToken(code, sessionId) {
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
                        saveSessionTokens(sessionId, tokenData);
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

function refreshSpotifyToken(refreshToken, sessionId) {
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
                        const currentTokens = getSessionTokens(sessionId) || {};
                        saveSessionTokens(sessionId, { ...currentTokens, access_token: tokenData.access_token });
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
                console.log('Spotify API response status:', res.statusCode);
                if (res.statusCode === 204) {
                    // No content - try recently played as fallback
                    getRecentlyPlayed(accessToken).then(resolve).catch(reject);
                    return;
                }
                if (res.statusCode === 401) {
                    const error = new Error('Unauthorized');
                    error.statusCode = 401;
                    reject(error);
                    return;
                }
                if (res.statusCode === 403) {
                    // Try to get user profile instead to show connection works
                    getUserProfile(accessToken).then(resolve).catch(() => {
                        resolve({ is_playing: false, item: null, message: 'Connected but limited access', needsUserAccess: true });
                    });
                    return;
                }
                if (res.statusCode === 429) {
                    resolve({ is_playing: false, item: null, message: 'Rate limited, try again later' });
                    return;
                }
                try {
                    const playbackData = data ? JSON.parse(data) : { is_playing: false, item: null };
                    console.log('Parsed playback data:', playbackData ? 'Success' : 'Empty');
                    resolve(playbackData);
                } catch (e) {
                    console.log('JSON parse error:', e.message);
                    reject(e);
                }
            });
        });

        req.on('error', (error) => {
            console.log('Request error:', error.message);
            reject(error);
        });
        req.end();
    });
}

function getRecentlyPlayed(accessToken) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.spotify.com',
            path: '/v1/me/player/recently-played?limit=1',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log('Recently played API response status:', res.statusCode);
                if (res.statusCode === 401) {
                    const error = new Error('Unauthorized');
                    error.statusCode = 401;
                    reject(error);
                    return;
                }
                if (res.statusCode === 403) {
                    // Try user profile as final fallback
                    getUserProfile(accessToken).then(resolve).catch(() => {
                        resolve({ is_playing: false, item: null, message: 'Connected but limited access', needsUserAccess: true });
                    });
                    return;
                }
                if (res.statusCode !== 200) {
                    resolve({ is_playing: false, item: null, message: 'No recent tracks available' });
                    return;
                }
                try {
                    const recentData = JSON.parse(data);
                    if (recentData.items && recentData.items.length > 0) {
                        const track = recentData.items[0].track;
                        resolve({
                            is_playing: false,
                            item: track,
                            message: 'Recently played (Free account)',
                            isFreeAccount: true
                        });
                    } else {
                        resolve({ is_playing: false, item: null, message: 'No recent tracks found' });
                    }
                } catch (e) {
                    console.log('Recently played JSON parse error:', e.message);
                    resolve({ is_playing: false, item: null, message: 'Error parsing recent tracks' });
                }
            });
        });

        req.on('error', (error) => {
            console.log('Recently played request error:', error.message);
            resolve({ is_playing: false, item: null, message: 'Connection error' });
        });
        req.end();
    });
}

function getUserProfile(accessToken) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.spotify.com',
            path: '/v1/me',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const profile = JSON.parse(data);
                        resolve({
                            is_playing: false,
                            item: null,
                            message: `Connected as ${profile.display_name || profile.id}`,
                            userProfile: profile,
                            isConnected: true
                        });
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error('Profile access failed'));
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
        const sessionId = generateSessionId();
        const authUrl = getSpotifyAuthUrl(sessionId);
        res.setHeader('Set-Cookie', `spotify_session=${sessionId}; HttpOnly; Path=/; Max-Age=86400`);
        res.writeHead(302, { 'Location': authUrl });
        res.end();
        return;
    }

    if (pathname === '/spotify-auth-implicit') {
        const scope = 'user-read-currently-playing user-read-playback-state user-read-recently-played';
        const params = {
            client_id: SPOTIFY_CLIENT_ID,
            response_type: 'token',
            redirect_uri: SPOTIFY_REDIRECT_URI,
            scope: scope,
            show_dialog: true
        };
        const authUrl = `https://accounts.spotify.com/authorize?${querystring.stringify(params)}`;
        res.writeHead(302, { 'Location': authUrl });
        res.end();
        return;
    }

    if (pathname === '/spotify-status') {
        const cookies = req.headers.cookie || '';
        const sessionMatch = cookies.match(/spotify_session=([^;]+)/);
        const sessionId = sessionMatch ? sessionMatch[1] : null;
        const tokens = sessionId ? getSessionTokens(sessionId) : null;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            connected: !!(tokens && tokens.access_token),
            hasRefreshToken: !!(tokens && tokens.refresh_token),
            sessionId: sessionId
        }));
        return;
    }

    if (pathname === '/debug-sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const sessionData = {};
        for (const [id, data] of sessions.entries()) {
            sessionData[id] = {
                hasAccessToken: !!data.access_token,
                hasRefreshToken: !!data.refresh_token,
                lastUsed: new Date(data.lastUsed).toISOString()
            };
        }
        res.end(JSON.stringify({ sessions: sessionData, totalSessions: sessions.size }));
        return;
    }

    if (pathname === '/' && url.searchParams.has('access_token')) {
        // Handle implicit grant flow
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script>
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash);
            const accessToken = params.get('access_token');
            if (accessToken) {
                localStorage.setItem('spotify_access_token', accessToken);
                window.opener && window.opener.postMessage({type: 'spotify-connected', success: true, token: accessToken}, '*');
                setTimeout(() => window.close(), 1000);
            }
        </script><h1>Spotify Connected Successfully!</h1><p>Closing window...</p>`);
        return;
    }

    if ((pathname === '/' || pathname === '/callback') && url.searchParams.has('code')) {
        const code = url.searchParams.get('code');
        const sessionId = url.searchParams.get('state');
        
        if (code && sessionId) {
            exchangeCodeForToken(code, sessionId)
                .then(tokenData => {
                    console.log('Token exchange successful for session:', sessionId);
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`<script>
                        window.opener && window.opener.postMessage({type: 'spotify-connected', success: true}, '*');
                        setTimeout(() => window.close(), 1000);
                    </script><h1>Spotify Connected Successfully!</h1><p>Closing window...</p>`);
                })
                .catch(error => {
                    console.log('Token exchange failed:', error);
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
        const cookies = req.headers.cookie || '';
        const sessionMatch = cookies.match(/spotify_session=([^;]+)/);
        const sessionId = sessionMatch ? sessionMatch[1] : null;
        const tokens = sessionId ? getSessionTokens(sessionId) : null;
        
        console.log('Spotify request - SessionId:', sessionId, 'HasTokens:', !!tokens);
        
        if (!tokens || !tokens.access_token) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not authenticated' }));
            return;
        }

        getCurrentPlayback(tokens.access_token)
            .then(playbackData => {
                console.log('Playback data received:', playbackData ? 'Has data' : 'No data');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(playbackData));
            })
            .catch(async (error) => {
                console.log('Spotify API error:', error.statusCode, error.message);
                if (error.statusCode === 401 && tokens.refresh_token) {
                    try {
                        console.log('Attempting token refresh...');
                        await refreshSpotifyToken(tokens.refresh_token, sessionId);
                        const updatedTokens = getSessionTokens(sessionId);
                        const playbackData = await getCurrentPlayback(updatedTokens.access_token);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(playbackData));
                    } catch (refreshError) {
                        console.log('Token refresh failed:', refreshError);
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Token refresh failed', needsReauth: true }));
                    }
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Spotify API error', details: error.message, statusCode: error.statusCode }));
                }
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
                notify: true,
                difficulty: diff // <-- Add this line
            }));
        });

    } else {
        ws.send(JSON.stringify({ type: 'waiting', message: 'Waiting for another player...' }));
    }

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch { return; }
        
        const room = rooms[ws.roomId];
        if (!room) return;
        
        if (data.type === 'join') {
            ws.selectedDifficulty = data.difficulty || "Easy";
            return;
        }
        
        if (data.type === 'chat') {
            // Broadcast chat message to all players in the room
            room.players.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'chat',
                        message: data.message,
                        player: data.player
                    }));
                }
            });
            return;
        }
        
        // Game-related messages require an active game
        if (!room.game) return;

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
    
    // Clean up old sessions every hour
    setInterval(cleanupOldSessions, 60 * 60 * 1000);
});

process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

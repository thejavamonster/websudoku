require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}`;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ALLOWED_DIFFICULTIES = new Set(['Easy', 'Medium', 'Hard', 'Stupidly Hard', 'Impossibly Hard']);

const sessions = new Map();
const onlineUsers = new Map();

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function readUserStore() {
    ensureDataDir();
    if (!fs.existsSync(USERS_FILE)) {
        return { users: {}, challenges: [], nextChallengeId: 1 };
    }

    try {
        const raw = fs.readFileSync(USERS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            users: parsed.users || {},
            challenges: parsed.challenges || [],
            nextChallengeId: parsed.nextChallengeId || 1
        };
    } catch (error) {
        console.error('Failed to read users store. Starting with empty store.', error.message);
        return { users: {}, challenges: [], nextChallengeId: 1 };
    }
}

const userStore = readUserStore();

function saveUserStore() {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(userStore, null, 2), 'utf8');
}

function normalizeUsername(username = '') {
    return String(username).trim().toLowerCase();
}

function normalizeEmail(email = '') {
    return String(email).trim().toLowerCase();
}

function hashPassword(password = '') {
    return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function sanitizePublicUser(user) {
    return {
        username: user.username,
        email: user.email,
        createdAt: user.createdAt
    };
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function notifyUser(username, payload) {
    const key = normalizeUsername(username);
    const sockets = onlineUsers.get(key);
    if (!sockets || sockets.size === 0) return;

    for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(payload));
        }
    }
}

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
    let cellsToRemove = 35; //35
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

    if (pathname === '/api/auth/register' && req.method === 'POST') {
        parseJsonBody(req)
            .then((body) => {
                const username = normalizeUsername(body.username);
                const email = normalizeEmail(body.email);
                const password = String(body.password || '');

                if (!username || !email || !password) {
                    sendJson(res, 400, { error: 'Username, email, and password are required.' });
                    return;
                }

                if (password.length < 4) {
                    sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
                    return;
                }

                if (userStore.users[username]) {
                    sendJson(res, 409, { error: 'Username already exists.' });
                    return;
                }

                const emailInUse = Object.values(userStore.users).some((user) => user.email === email);
                if (emailInUse) {
                    sendJson(res, 409, { error: 'Email already in use.' });
                    return;
                }

                userStore.users[username] = {
                    username,
                    email,
                    passwordHash: hashPassword(password),
                    createdAt: new Date().toISOString()
                };
                saveUserStore();

                sendJson(res, 201, {
                    success: true,
                    user: sanitizePublicUser(userStore.users[username])
                });
            })
            .catch((error) => sendJson(res, 400, { error: error.message || 'Bad request' }));
        return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
        parseJsonBody(req)
            .then((body) => {
                const username = normalizeUsername(body.username);
                const password = String(body.password || '');
                const user = userStore.users[username];

                if (!user || user.passwordHash !== hashPassword(password)) {
                    sendJson(res, 401, { error: 'Invalid username or password.' });
                    return;
                }

                sendJson(res, 200, { success: true, user: sanitizePublicUser(user) });
            })
            .catch((error) => sendJson(res, 400, { error: error.message || 'Bad request' }));
        return;
    }

    if (pathname === '/api/users' && req.method === 'GET') {
        const current = normalizeUsername(url.searchParams.get('username') || '');
        if (!current || !userStore.users[current]) {
            sendJson(res, 401, { error: 'Please log in first.' });
            return;
        }

        const users = Object.values(userStore.users)
            .filter((user) => user.username !== current)
            .map((user) => ({ username: user.username, email: user.email }));

        sendJson(res, 200, { users });
        return;
    }

    if (pathname === '/api/challenges' && req.method === 'GET') {
        const current = normalizeUsername(url.searchParams.get('username') || '');
        if (!current || !userStore.users[current]) {
            sendJson(res, 401, { error: 'Please log in first.' });
            return;
        }

        const challenges = userStore.challenges
            .filter((challenge) => challenge.toUser === current || challenge.fromUser === current)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        sendJson(res, 200, { challenges });
        return;
    }

    if (pathname === '/api/challenges/send' && req.method === 'POST') {
        parseJsonBody(req)
            .then((body) => {
                const fromUser = normalizeUsername(body.fromUser);
                const toUser = normalizeUsername(body.toUser);
                const difficulty = ALLOWED_DIFFICULTIES.has(body.difficulty) ? body.difficulty : 'Easy';

                if (!fromUser || !toUser) {
                    sendJson(res, 400, { error: 'Both users are required.' });
                    return;
                }

                if (fromUser === toUser) {
                    sendJson(res, 400, { error: 'You cannot challenge yourself.' });
                    return;
                }

                if (!userStore.users[fromUser] || !userStore.users[toUser]) {
                    sendJson(res, 404, { error: 'User not found.' });
                    return;
                }

                const now = new Date().toISOString();
                const challenge = {
                    id: userStore.nextChallengeId++,
                    fromUser,
                    toUser,
                    difficulty,
                    status: 'pending',
                    createdAt: now,
                    updatedAt: now,
                    roomId: null
                };

                userStore.challenges.push(challenge);
                saveUserStore();

                notifyUser(toUser, { type: 'challenge-updated', challenge });
                notifyUser(fromUser, { type: 'challenge-updated', challenge });

                sendJson(res, 201, { success: true, challenge });
            })
            .catch((error) => sendJson(res, 400, { error: error.message || 'Bad request' }));
        return;
    }

    if (pathname === '/api/challenges/respond' && req.method === 'POST') {
        parseJsonBody(req)
            .then((body) => {
                const username = normalizeUsername(body.username);
                const challengeId = Number(body.challengeId);
                const accept = !!body.accept;

                const challenge = userStore.challenges.find((item) => item.id === challengeId);
                if (!challenge) {
                    sendJson(res, 404, { error: 'Challenge not found.' });
                    return;
                }

                if (challenge.toUser !== username) {
                    sendJson(res, 403, { error: 'You can only respond to your own challenges.' });
                    return;
                }

                if (challenge.status !== 'pending') {
                    sendJson(res, 400, { error: 'Challenge was already handled.' });
                    return;
                }

                challenge.status = accept ? 'accepted' : 'rejected';
                challenge.updatedAt = new Date().toISOString();

                if (accept) {
                    const roomId = nextRoomId++;
                    rooms[roomId] = {
                        id: roomId,
                        players: [],
                        participants: [challenge.fromUser, challenge.toUser],
                        game: null,
                        difficulty: challenge.difficulty
                    };
                    startNewGameForRoom(roomId, challenge.difficulty);
                    challenge.roomId = roomId;

                    notifyUser(challenge.fromUser, {
                        type: 'challenge-accepted',
                        roomId,
                        difficulty: challenge.difficulty,
                        opponent: challenge.toUser,
                        challengeId: challenge.id
                    });

                    notifyUser(challenge.toUser, {
                        type: 'challenge-accepted',
                        roomId,
                        difficulty: challenge.difficulty,
                        opponent: challenge.fromUser,
                        challengeId: challenge.id
                    });
                } else {
                    notifyUser(challenge.fromUser, {
                        type: 'challenge-rejected',
                        challengeId: challenge.id,
                        by: challenge.toUser
                    });
                }

                notifyUser(challenge.fromUser, { type: 'challenge-updated', challenge });
                notifyUser(challenge.toUser, { type: 'challenge-updated', challenge });
                saveUserStore();

                sendJson(res, 200, { success: true, challenge });
            })
            .catch((error) => sendJson(res, 400, { error: error.message || 'Bad request' }));
        return;
    }

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

function getPlayerNumber(room, username) {
    const index = room.participants.indexOf(username);
    return index >= 0 ? index + 1 : null;
}

function broadcastToRoom(room, payload) {
    room.players.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

function maybeStartRoom(room) {
    const socketsByUser = new Map();
    for (const client of room.players) {
        if (client.readyState === WebSocket.OPEN && client.username) {
            socketsByUser.set(client.username, client);
        }
    }

    const hasBothPlayers = room.participants.every((username) => socketsByUser.has(username));
    if (!hasBothPlayers) {
        room.participants.forEach((username) => {
            const client = socketsByUser.get(username);
            if (client && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'waiting', message: 'Waiting for the other challenged player...' }));
            }
        });
        return;
    }

    room.participants.forEach((username, index) => {
        const client = socketsByUser.get(username);
        // Send both player usernames for chat display
        const player1 = room.participants[0];
        const player2 = room.participants[1];
        client.send(JSON.stringify({
            type: 'init',
            grid: room.game.grid,
            solution: room.game.solution,
            mistakes: room.game.mistakes,
            currentPlayer: room.game.currentPlayer,
            playerNum: index + 1,
            notify: true,
            difficulty: room.difficulty,
            player1Name: player1,
            player2Name: player2
        }));
    });
}

wss.on('connection', (ws, req) => {
        // Wildcard multiplayer queue
        if (!global.wildcardQueue) global.wildcardQueue = [];
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const username = normalizeUsername(reqUrl.searchParams.get('username') || '');
    ws.username = username;
    ws.roomId = null;

    if (username && userStore.users[username]) {
        if (!onlineUsers.has(username)) {
            onlineUsers.set(username, new Set());
        }
        onlineUsers.get(username).add(ws);
    }

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch {
            return;
        }

        if (!ws.username || !userStore.users[ws.username]) {
            ws.send(JSON.stringify({ type: 'auth-required', message: 'Please log in to use multiplayer and challenges.' }));
            return;
        }

        // Handle leave-game from client
        if (data.type === 'leave-game') {
            const room = rooms[ws.roomId];
            if (room && room.game) {
                // Remove this player from the room
                room.players = room.players.filter((client) => client !== ws);
                // Notify the other player if still connected
                if (room.players.length === 1) {
                    const remainingClient = room.players[0];
                    if (remainingClient.readyState === WebSocket.OPEN) {
                        remainingClient.send(JSON.stringify({
                            type: 'gameover',
                            message: 'Other player disconnected.'
                        }));
                        room.game = null;
                    } else {
                        // Store pending win for this username
                        room.pendingWinFor = remainingClient.username;
                        room.game = null;
                    }
                }
                if (room.players.length === 0) {
                    delete rooms[ws.roomId];
                }
            }
            ws.roomId = null;
            return;
        }

        // Wildcard multiplayer logic
        if (data.type === 'wildcard-join') {
            // Remove from queue if already present
            global.wildcardQueue = global.wildcardQueue.filter(u => u.username !== ws.username);
            // Add to queue
            global.wildcardQueue.push({ username: ws.username, ws, difficulty: data.difficulty });
            // If two or more in queue, match the first two
            if (global.wildcardQueue.length >= 2) {
                const [p1, p2] = global.wildcardQueue.splice(0, 2);
                const roomId = nextRoomId++;
                rooms[roomId] = {
                    id: roomId,
                    players: [p1.ws, p2.ws],
                    participants: [p1.username, p2.username],
                    game: null,
                    difficulty: p1.difficulty || 'Easy'
                };
                startNewGameForRoom(roomId, p1.difficulty || 'Easy');
                // Assign roomId to sockets
                p1.ws.roomId = roomId;
                p2.ws.roomId = roomId;
                // Notify both clients to start
                maybeStartRoom(rooms[roomId]);
            } else {
                ws.send(JSON.stringify({ type: 'waiting', message: 'Waiting for another player to join wild card...' }));
            }
            return;
        }

        if (data.type === 'joinRoom') {
            const roomId = Number(data.roomId);
            const room = rooms[roomId];

            if (!room) {
                ws.send(JSON.stringify({ type: 'error', message: 'Game room not found.' }));
                return;
            }

            if (!room.participants.includes(ws.username)) {
                ws.send(JSON.stringify({ type: 'error', message: 'You are not part of this challenge room.' }));
                return;
            }

            ws.roomId = roomId;
            if (!room.players.includes(ws)) {
                room.players.push(ws);
            }
            // Check for pending win
            if (room.pendingWinFor && room.pendingWinFor === ws.username) {
                ws.send(JSON.stringify({
                    type: 'gameover',
                    message: 'Other player disconnected.'
                }));
                delete room.pendingWinFor;
                room.game = null;
                return;
            }
            maybeStartRoom(room);
            return;
        }

        if (data.type === 'chat') {
            const room = rooms[ws.roomId];
            if (!room) return;
            broadcastToRoom(room, {
                type: 'chat',
                message: data.message,
                player: getPlayerNumber(room, ws.username)
            });
            return;
        }

        const room = rooms[ws.roomId];
        if (!room || !room.game) return;

        const currentPlayerNumber = getPlayerNumber(room, ws.username);
        if (room.game.currentPlayer !== currentPlayerNumber) return;

        if (data.type === 'move') {
            const { row, col, value } = data.move;
            room.game.grid[row][col] = value;
            room.game.moves.push({ row, col, value, player: currentPlayerNumber });
            room.game.currentPlayer = room.game.currentPlayer === 1 ? 2 : 1;

            broadcastToRoom(room, {
                type: 'move',
                move: { row, col, value, player: currentPlayerNumber },
                currentPlayer: room.game.currentPlayer
            });

            const isSolved = room.game.grid.every((rowArr, i) =>
                rowArr.every((cell, j) => cell === room.game.solution[i][j])
            );

            if (isSolved) {
                broadcastToRoom(room, {
                    type: 'gameover',
                    player1Mistakes: room.game.mistakes[0],
                    player2Mistakes: room.game.mistakes[1]
                });
                room.game = null;
            }
            return;
        }

        if (data.type === 'mistake') {
            const idx = currentPlayerNumber - 1;
            room.game.mistakes[idx]++;
            room.game.currentPlayer = room.game.currentPlayer === 1 ? 2 : 1;

            broadcastToRoom(room, {
                type: 'mistake',
                mistakes: room.game.mistakes,
                cell: data.cell,
                wrongValue: data.wrongValue,
                currentPlayer: room.game.currentPlayer,
                player: currentPlayerNumber
            });

            if (room.game.mistakes[idx] >= 3) {
                broadcastToRoom(room, { type: 'gameover', loser: currentPlayerNumber });
                room.game = null;
            }
        }
    });

    ws.on('close', () => {
        if (ws.username && onlineUsers.has(ws.username)) {
            onlineUsers.get(ws.username).delete(ws);
            if (onlineUsers.get(ws.username).size === 0) {
                onlineUsers.delete(ws.username);
            }
        }

        const room = rooms[ws.roomId];
        if (!room) return;

        room.players = room.players.filter((client) => client !== ws);
        if (room.players.length === 1 && room.game) {
            const remainingClient = room.players[0];
            // If the remaining client is open, send the message immediately
            if (remainingClient.readyState === WebSocket.OPEN) {
                remainingClient.send(JSON.stringify({
                    type: 'gameover',
                    message: 'Other player disconnected.'
                }));
                room.game = null;
            } else {
                // Store pending win for this username
                room.pendingWinFor = remainingClient.username;
                room.game = null;
            }
        }

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

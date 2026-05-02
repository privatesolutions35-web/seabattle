const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const publicPath = path.join(__dirname, 'public');
const indexPath = path.join(publicPath, 'index.html');

console.log('Public path:', publicPath);
console.log('Index exists:', fs.existsSync(indexPath));

const rooms = new Map();
const players = new Map();
let onlineCount = 0;

wss.on('connection', (ws) => {
    onlineCount++;
    broadcastOnlineCount();
    let playerId = null;
    let roomCode = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'getRooms':
                    const roomList = [];
                    rooms.forEach((room, code) => {
                        if (room.gameState === 'waiting' && room.players.length < 2) {
                            roomList.push({ code, players: room.players.length, bet: room.bet });
                        }
                    });
                    ws.send(JSON.stringify({ type: 'roomsList', rooms: roomList }));
                    break;

                case 'getOnline':
                    ws.send(JSON.stringify({ type: 'onlineCount', count: onlineCount }));
                    break;

                case 'create':
                    playerId = generateId();
                    roomCode = generateRoomCode();
                    const bet = msg.bet || 1;
                    rooms.set(roomCode, {
                        players: [{ id: playerId, ws, ready: false, board: null, ships: [] }],
                        gameState: 'waiting',
                        bet: bet,
                        prizePool: bet * 2
                    });
                    players.set(playerId, { ws, roomCode });
                    ws.send(JSON.stringify({ type: 'created', roomCode, playerId }));
                    break;

                case 'join':
                    const room = rooms.get(msg.roomCode);
                    if (room && room.players.length < 2) {
                        room.prizePool += room.bet;
                        playerId = generateId();
                        room.players.push({ id: playerId, ws, ready: false, board: null, ships: [] });
                        players.set(playerId, { ws, roomCode: msg.roomCode });
                        roomCode = msg.roomCode;

                        ws.send(JSON.stringify({ type: 'joined', roomCode, playerId, playerNum: 2 }));
                        
                        room.players[0].ws.send(JSON.stringify({ type: 'playerJoined', playerNum: 2 }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена или полна' }));
                    }
                    break;

                case 'ready':
                    const r = rooms.get(roomCode);
                    if (r) {
                        const p = r.players.find(p => p.id === playerId);
                        if (p) {
                            p.ready = true;
                            p.board = msg.board;
                            p.ships = msg.ships;

                            const allReady = r.players.every(pl => pl.ready);
                            if (allReady && r.players.length === 2) {
                                r.gameState = 'playing';
                                r.currentPlayer = r.players[0].id;
                                r.players.forEach(pl => {
                                    const opponent = r.players.find(p => p.id !== pl.id);
                                    pl.ws.send(JSON.stringify({ 
                                        type: 'start', 
                                        currentPlayer: r.currentPlayer,
                                        opponentShips: opponent ? opponent.ships : []
                                    }));
                                });
                            } else {
                                r.players.forEach(pl => {
                                    if (pl.id !== playerId) {
                                        pl.ws.send(JSON.stringify({ type: 'playerReady', playerId }));
                                    }
                                });
                            }
                        }
                    }
                    break;

                case 'shoot':
                    const roomData = rooms.get(roomCode);
                    if (roomData && roomData.gameState === 'playing') {
                        if (roomData.currentPlayer === playerId) {
                            const targetPlayer = roomData.players.find(p => p.id !== playerId);
                            if (targetPlayer) {
                                const result = checkShot(targetPlayer.board, msg.row, msg.col);
                                
                                roomData.players.forEach(pl => {
                                    pl.ws.send(JSON.stringify({
                                        type: 'shotResult',
                                        row: msg.row,
                                        col: msg.col,
                                        result: result.type,
                                        playerId: playerId
                                    }));
                                });

                                if (result.type === 'miss') {
                                    roomData.currentPlayer = targetPlayer.id;
                                    roomData.players.forEach(pl => {
                                        pl.ws.send(JSON.stringify({ 
                                            type: 'nextTurn', 
                                            playerId: roomData.currentPlayer 
                                        }));
                                    });
                                } else if (result.type === 'sunk') {
                                    if (checkWin(targetPlayer.board, targetPlayer.ships)) {
                                        roomData.gameState = 'ended';
                                        roomData.players.forEach(pl => {
                                            pl.ws.send(JSON.stringify({ 
                                                type: 'gameOver', 
                                                winner: playerId 
                                            }));
                                        });
                                    }
                                }
                            }
                        }
                    }
                    break;

                case 'surrender':
                    const surrenderRoom = rooms.get(roomCode);
                    if (surrenderRoom && surrenderRoom.gameState === 'playing') {
                        surrenderRoom.gameState = 'ended';
                        const winner = surrenderRoom.players.find(p => p.id !== playerId);
                        surrenderRoom.players.forEach(pl => {
                            pl.ws.send(JSON.stringify({ 
                                type: 'gameOver', 
                                winner: winner ? winner.id : playerId,
                                surrendered: playerId
                            }));
                        });
                    }
                    break;
            }
        } catch (e) {
            console.error('Error:', e);
        }
    });

    ws.on('close', () => {
        onlineCount--;
        broadcastOnlineCount();
        if (playerId && roomCode) {
            const room = rooms.get(roomCode);
            if (room) {
                room.players.forEach(p => {
                    if (p.id !== playerId) {
                        p.ws.send(JSON.stringify({ type: 'opponentLeft' }));
                    }
                });
                rooms.delete(roomCode);
            }
            players.delete(playerId);
        }
    });
});

function checkShot(board, row, col) {
    if (board[row][col] === 3) {
        board[row][col] = 2;
        return { type: 'hit' };
    } else if (board[row][col] === 0) {
        board[row][col] = 1;
        return { type: 'miss' };
    }
    return { type: 'already' };
}

function checkWin(board, ships) {
    return ships.every(ship => {
        for (let i = 0; i < ship.size; i++) {
            const r = ship.horizontal ? ship.row : ship.row + i;
            const c = ship.horizontal ? ship.col + i : ship.col;
            if (board[r][c] !== 2) return false;
        }
        return true;
    });
}

function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcastOnlineCount() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'onlineCount', count: onlineCount }));
        }
    });
}

app.use(express.static(publicPath));

app.get('/', (req, res) => {
    res.sendFile(indexPath);
});

app.get('*', (req, res) => {
    res.sendFile(indexPath);
});

const users = new Map();

app.use(express.json());

app.post('/api/deposit/check', async (req, res) => {
    const { address } = req.body;
    const API_KEY = 'be731a50-abde-4c61-9766-4fc4b0ea5211';
    
    try {
        const response = await fetch(`https://apilive.tronscan.org/api/transaction?address=${address}&limit=10`, {
            headers: { 'Authorization': API_KEY }
        });
        const data = await response.json();
        
        const deposits = data.data?.filter(tx => 
            tx.to_address === address && 
            tx.contract_type === 'Transfer' &&
            tx.token_info?.symbol === 'USDT'
        ) || [];
        
        res.json({ success: true, deposits });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/user/register', (req, res) => {
    const { username, password } = req.body;
    if (users.has(username)) {
        res.json({ success: false, error: 'Username exists' });
        return;
    }
    users.set(username, { password, balance: 0 });
    res.json({ success: true });
});

app.post('/api/user/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);
    if (user && user.password === password) {
        res.json({ success: true, balance: user.balance });
    } else {
        res.json({ success: false, error: 'Invalid credentials' });
    }
});

app.post('/api/user/balance', (req, res) => {
    const { username } = req.body;
    const user = users.get(username);
    res.json({ success: true, balance: user?.balance || 0 });
});

app.post('/api/user/deposit', (req, res) => {
    const { username, amount } = req.body;
    const user = users.get(username);
    if (user) {
        user.balance += amount;
        res.json({ success: true, balance: user.balance });
    } else {
        res.json({ success: false });
    }
});

const withdrawals = [];

app.post('/api/withdraw/request', (req, res) => {
    const { username, address, amount } = req.body;
    const user = users.get(username);
    if (!user) {
        res.json({ success: false, error: 'User not found' });
        return;
    }
    const fee = amount * 0.05;
    const total = amount + fee;
    if (user.balance < total) {
        res.json({ success: false, error: 'Insufficient balance' });
        return;
    }
    user.balance -= total;
    withdrawals.push({ username, address, amount, fee, date: Date.now(), status: 'pending' });
    res.json({ success: true, balance: user.balance });
});

app.get('/api/withdraw/list', (req, res) => {
    res.json({ success: true, withdrawals });
});

app.post('/api/withdraw/approve', (req, res) => {
    const { index } = req.body;
    if (withdrawals[index]) {
        withdrawals[index].status = 'completed';
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
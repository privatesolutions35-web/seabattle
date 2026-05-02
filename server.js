const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
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
                            roomList.push({ code, players: room.players.length });
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
                    rooms.set(roomCode, {
                        players: [{ id: playerId, ws, ready: false, board: null, ships: [] }],
                        gameState: 'waiting'
                    });
                    players.set(playerId, { ws, roomCode });
                    ws.send(JSON.stringify({ type: 'created', roomCode, playerId }));
                    break;

                case 'join':
                    const room = rooms.get(msg.roomCode);
                    if (room && room.players.length < 2) {
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
                                    pl.ws.send(JSON.stringify({ 
                                        type: 'start', 
                                        currentPlayer: r.currentPlayer 
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Serving static from: ${path.resolve(__dirname, 'public')}`);
});
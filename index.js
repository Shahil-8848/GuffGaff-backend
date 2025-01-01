const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
// const ConnectionManager = require("./server/connectionManager");

const setupSocketHandlers = require("./server/socketHandlers");

// Environment variables
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
  : ["https://localhost:5173"];
const NODE_ENV = process.env.NODE_ENV || "production";
const RATE_LIMIT_WINDOW =
  parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.set("trust proxy", "loopback");

const corsOptions = {
  origin: NODE_ENV === "production" ? CORS_ORIGIN : "*",
  methods: ["GET", "POST"],
  credentials: true,
};

app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: false,
});
app.use(limiter);

// Socket.IO setup
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/socket.io",
  connectTimeout: 45000,
  maxHttpBufferSize: 1e6,
});
class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
    this.connectionTimeouts = new Map();
    this.maxConnectionAttempts = 3;
    this.connectionTimeout = 30000;
  }
  addUser(socketId, userId) {
    this.users.set(socketId, {
      userId,
      inCall: false,
      room: null,
      connectedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
    });
  }
  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (user && user.room) {
      this.breakPartnership(socketId);
    }
    this.users.delete(socketId);
    this.removeFromWaitingQueue(socketId);
  }
  addToWaitingQueue(socketId) {
    if (!this.waitingQueue.includes(socketId)) {
      this.waitingQueue.push(socketId);
      return true;
    }
    return false;
  }
  removeFromWaitingQueue(socketId) {
    const index = this.waitingQueue.indexOf(socketId);
    if (index > -1) {
      this.waitingQueue.splice(index, 1);
      return true;
    }
    return false;
  }
  getNextWaitingUser() {
    if (this.waitingQueue.length > 0) {
      return this.waitingQueue.shift();
    }
    return null;
  }
  createPartnership(socket1Id, socket2Id) {
    const roomId = `room_${++this.roomCounter}`;
    this.partnerships.set(socket1Id, socket2Id);
    this.partnerships.set(socket2Id, socket1Id);
    this.rooms.set(roomId, {
      participants: [socket1Id, socket2Id],
      createdAt: new Date().toISOString(),
    });
    const user1 = this.users.get(socket1Id);
    const user2 = this.users.get(socket2Id);
    if (user1 && user2) {
      user1.inCall = true;
      user2.inCall = true;
      user1.room = roomId;
      user2.room = roomId;
    }
    return roomId;
  }
  findRoomByPeerId(peerId) {
    for (const [roomId, room] of this.rooms) {
      if (room.participants.includes(peerId)) {
        return { roomId, participants: room.participants };
      }
    }
    return null;
  }
  breakPartnership(socketId) {
    const partnerId = this.partnerships.get(socketId);
    if (partnerId) {
      const user = this.users.get(socketId);
      const partnerUser = this.users.get(partnerId);

      if (user && user.room) {
        if (this.connectionTimeouts.has(user.room)) {
          clearTimeout(this.connectionTimeouts.get(user.room));
          this.connectionTimeouts.delete(user.room);
        }
        this.rooms.delete(user.room);
      }
      // Clean up user states
      [user, partnerUser].forEach((u) => {
        if (u) {
          u.inCall = false;
          u.room = null;
          u.signalingState = "new";
        }
      });
      // Remove partnerships
      this.partnerships.delete(socketId);
      this.partnerships.delete(partnerId);
      return partnerId;
    }
    return null;
  }
  getConnectionStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
    };
  }
  updateUserActivity(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      user.lastActive = new Date().toISOString();
    }
  }
  validatePeers(fromPeerId, toPeerId) {
    const room = this.findRoomByPeerId(fromPeerId);
    if (!room) return null;

    const otherParticipant = room.participants.find((p) => p !== fromPeerId);
    if (otherParticipant !== toPeerId) return null;

    return room;
  }
}
module.exports = ConnectionManager;

// Initialize connection manager and setup socket handlers
const connectionManager = new ConnectionManager();
setupSocketHandlers(io, connectionManager);

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    stats: connectionManager.getConnectionStats(),
    environment: NODE_ENV,
  });
});

// Error handling for WebSocket upgrades
server.on("upgrade", (request, socket, head) => {
  socket.on("error", (err) => {
    console.error("Socket upgrade error:", err);
  });
});

io.engine.on("connection_error", (err) => {
  console.error("Connection error:", err);
});

// Start server
server.listen(PORT, () => {
  console.log(`
🚀 Server Status:
- Environment: ${NODE_ENV}
- Port: ${PORT}
- WebSocket: Ready
- Cors Origin: ${CORS_ORIGIN}
  `);
});

// Global error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

module.exports = { app, server, io };

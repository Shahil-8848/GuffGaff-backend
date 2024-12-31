const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

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
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/socket.io",
});

// Connection Manager Class
class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
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
        this.rooms.delete(user.room);
      }

      if (user) {
        user.inCall = false;
        user.room = null;
      }
      if (partnerUser) {
        partnerUser.inCall = false;
        partnerUser.room = null;
      }

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
}

const connectionManager = new ConnectionManager();

// Logging middleware
const logEvent = (event, socketId, data = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${event} | Socket: ${socketId} | Data:`, data);
};

// Socket.IO event handlers
io.on("connection", (socket) => {
  logEvent("connection", socket.id);
  console.log(`New connection: ${socket.id}`);

  connectionManager.addUser(socket.id);
  io.emit("stats-update", connectionManager.getConnectionStats());

  socket.on("find-match", () => {
    logEvent("find-match", socket.id);
    const oldPartnerId = connectionManager.breakPartnership(socket.id);
    if (oldPartnerId) {
      io.to(oldPartnerId).emit("partner-left", {
        reason: "Partner requested new match",
        timestamp: new Date().toISOString(),
      });
    }

    const waitingPartnerId = connectionManager.getNextWaitingUser();
    if (waitingPartnerId) {
      const roomId = connectionManager.createPartnership(
        socket.id,
        waitingPartnerId
      );
      const matchData = {
        timestamp: new Date().toISOString(),
        roomId,
        matchId: `${socket.id.slice(0, 4)}-${waitingPartnerId.slice(0, 4)}`,
      };

      socket.emit("match", {
        ...matchData,
        peerId: waitingPartnerId,
        isInitiator: false,
      });
      io.to(waitingPartnerId).emit("match", {
        ...matchData,
        peerId: socket.id,
        isInitiator: true,
      });

      logEvent("match-created", socket.id, {
        partnerId: waitingPartnerId,
        roomId,
        initiator: waitingPartnerId,
      });
    } else {
      connectionManager.addToWaitingQueue(socket.id);
      socket.emit("waiting", {
        position: connectionManager.waitingQueue.length,
        timestamp: new Date().toISOString(),
      });
    }
    io.emit("stats-update", connectionManager.getConnectionStats());
  });

  socket.on("offer", ({ peerId, offer, fromPeerId }) => {
    console.log(`Forwarding offer from ${fromPeerId} to ${peerId}`);
    io.to(peerId).emit("offer", { offer, fromPeerId });
  });

  socket.on("answer", ({ peerId, answer, fromPeerId }) => {
    console.log(`Forwarding answer from ${fromPeerId} to ${peerId}`);
    io.to(peerId).emit("answer", { answer, fromPeerId });
  });

  socket.on("ice-candidate", ({ peerId, candidate, fromPeerId }) => {
    console.log(`Forwarding ICE candidate from ${fromPeerId} to ${peerId}`);
    const room = connectionManager.findRoomByPeerId(fromPeerId);

    if (!room) {
      console.log(`Room not found for peer ${fromPeerId}`);
      return;
    }

    const otherPeer = room.participants.find((p) => p !== fromPeerId);
    if (!otherPeer) {
      console.log(`Other peer not found in room for ${fromPeerId}`);
      return;
    }

    io.to(otherPeer).emit("ice-candidate", {
      candidate,
      fromPeerId,
    });
  });

  socket.on("disconnect", (reason) => {
    logEvent("disconnect", socket.id);
    console.log(`Socket ${socket.id} disconnected. Reason: ${reason}`);

    const partnerId = connectionManager.breakPartnership(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("partner-left", {
        reason: "Partner disconnected",
        timestamp: new Date().toISOString(),
      });
    }

    connectionManager.removeUser(socket.id);
    io.emit("stats-update", connectionManager.getConnectionStats());
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    stats: connectionManager.getConnectionStats(),
  });
});

// WebSocket specific error handling
server.on("upgrade", (request, socket, head) => {
  socket.on("error", (err) => {
    console.error("Socket upgrade error:", err);
  });
});

io.engine.on("connection_error", (err) => {
  console.error("Connection error:", err);
});

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

// Start server
server.listen(PORT, () => {
  console.log(`
🚀 Server Status:
- Environment: ${NODE_ENV}
- Port: ${PORT}
- WebSocket: Ready
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

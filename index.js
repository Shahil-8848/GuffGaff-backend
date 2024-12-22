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
  : ["http://localhost:3000"];
const NODE_ENV = process.env.NODE_ENV || "production";
const RATE_LIMIT_WINDOW =
  parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet());
app.set("trust proxy", "loopback");

const corsOptions = {
  origin: CORS_ORIGIN,
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
});

// Connection Manager
class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
  }

  addUser(socketId) {
    this.users.set(socketId, {
      inCall: false,
      connectedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      room: null,
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

  createPartnership(socket1Id, socket2Id) {
    const roomId = `room_${++this.roomCounter}`;
    this.partnerships.set(socket1Id, socket2Id);
    this.partnerships.set(socket2Id, socket1Id);

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

  breakPartnership(socketId) {
    const partnerId = this.partnerships.get(socketId);
    if (partnerId) {
      const partnerUser = this.users.get(partnerId);
      const user = this.users.get(socketId);
      if (partnerUser) {
        partnerUser.inCall = false;
        partnerUser.room = null;
      }
      if (user) {
        user.inCall = false;
        user.room = null;
      }
      this.partnerships.delete(partnerId);
      this.partnerships.delete(socketId);
      return partnerId;
    }
    return null;
  }

  getNextWaitingUser() {
    while (this.waitingQueue.length > 0) {
      const nextId = this.waitingQueue.shift();
      if (this.users.has(nextId) && !this.partnerships.has(nextId)) {
        return nextId;
      }
    }
    return null;
  }

  updateUserActivity(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      user.lastActive = new Date().toISOString();
    }
  }

  getConnectionStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
    };
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

      socket.emit("match", { ...matchData, peerId: waitingPartnerId });
      io.to(waitingPartnerId).emit("match", {
        ...matchData,
        peerId: socket.id,
      });

      logEvent("match-created", socket.id, {
        partnerId: waitingPartnerId,
        roomId,
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

  socket.on("offer", (data) => {
    logEvent("offer", socket.id, { peerId: data.peerId });
    io.to(data.peerId).emit("offer", {
      offer: data.offer,
      peerId: socket.id,
    });
  });

  socket.on("answer", (data) => {
    logEvent("answer", socket.id, { peerId: data.peerId });
    io.to(data.peerId).emit("answer", {
      answer: data.answer,
      peerId: socket.id,
    });
  });

  socket.on("ice-candidate", (data) => {
    logEvent("ice-candidate", socket.id, { peerId: data.peerId });
    io.to(data.peerId).emit("ice-candidate", {
      candidate: data.candidate,
      peerId: socket.id,
    });
  });

  socket.on("disconnect", () => {
    logEvent("disconnect", socket.id);

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

// Start server
server.listen(PORT, () => {
  console.log(`
🚀 Server Status:
- Environment: ${NODE_ENV}
- Port: ${PORT}
- WebSocket: Ready
  `);
});

module.exports = { app, server, io };

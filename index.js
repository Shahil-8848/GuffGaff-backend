const express = require("express");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const http = require("http");

// Environment variables
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const NODE_ENV = process.env.NODE_ENV || "production";

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "wss:", "https:"],
        mediaSrc: ["'self'", "https:", "blob:"],
        imgSrc: ["'self'", "data:", "blob:"],
        workerSrc: ["'self'", "blob:"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

const corsOptions = {
  origin: CORS_ORIGIN,
  methods: ["GET", "POST"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  upgradeTimeout: 10000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: {
    threshold: 1024,
  },
  path: "/socket.io/",
});

// Data structures for managing connections
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
      connectionStatus: "online",
      room: null,
    });
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (user && user.room) {
      this.leaveRoom(socketId, user.room);
    }
    this.users.delete(socketId);
    this.removeFromWaitingQueue(socketId);
    return this.breakPartnership(socketId);
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
      if (partnerUser) {
        partnerUser.inCall = false;
        partnerUser.room = null;
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

// Initialize connection manager
const connectionManager = new ConnectionManager();

// Logging middleware
const logEvent = (event, socketId, data = {}) => {
  if (NODE_ENV !== "production") {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${event} | Socket: ${socketId} | Data:`, data);
  }
};

// Socket.io event handlers
io.on("connection", (socket) => {
  logEvent("connection", socket.id);

  // Initialize user
  connectionManager.addUser(socket.id);

  // Send initial connection stats
  io.emit("stats-update", connectionManager.getConnectionStats());

  // Heartbeat mechanism
  const heartbeatInterval = setInterval(() => {
    if (connectionManager.users.has(socket.id)) {
      socket.emit("heartbeat", { timestamp: new Date().toISOString() });
    }
  }, 30000);

  socket.on("heartbeat", () => {
    connectionManager.updateUserActivity(socket.id);
  });

  // Handle match finding
  socket.on("find-match", () => {
    logEvent("find-match", socket.id);

    // Break existing partnership if any
    const oldPartnerId = connectionManager.breakPartnership(socket.id);
    if (oldPartnerId) {
      io.to(oldPartnerId).emit("partner-left", {
        reason: "Partner requested new match",
        timestamp: new Date().toISOString(),
      });
    }

    // Look for waiting partner
    const waitingPartnerId = connectionManager.getNextWaitingUser();

    if (waitingPartnerId) {
      const roomId = connectionManager.createPartnership(
        socket.id,
        waitingPartnerId
      );

      // Notify both users of the match
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

  // WebRTC signaling handlers
  socket.on("offer", (data) => {
    logEvent("offer", socket.id, { peerId: data.peerId });
    io.to(data.peerId).emit("offer", {
      offer: data.offer,
      peerId: socket.id,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("answer", (data) => {
    logEvent("answer", socket.id, { peerId: data.peerId });
    io.to(data.peerId).emit("answer", {
      answer: data.answer,
      peerId: socket.id,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("ice-candidate", (data) => {
    logEvent("ice-candidate", socket.id, { peerId: data.peerId });
    io.to(data.peerId).emit("ice-candidate", {
      candidate: data.candidate,
      peerId: socket.id,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    logEvent("disconnect", socket.id);
    clearInterval(heartbeatInterval);

    const partnerId = connectionManager.removeUser(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("partner-left", {
        reason: "Partner disconnected",
        timestamp: new Date().toISOString(),
      });
    }

    io.emit("stats-update", connectionManager.getConnectionStats());
  });

  // Error handling
  socket.on("error", (error) => {
    logEvent("error", socket.id, error);
    socket.emit("server-error", {
      message: "An error occurred",
      timestamp: new Date().toISOString(),
    });
  });
});

// Periodic cleanup of stale connections
setInterval(() => {
  const now = new Date();
  const staleThreshold = 60000; // 1 minute

  connectionManager.users.forEach((user, socketId) => {
    const lastActive = new Date(user.lastActive);
    if (now.getTime() - lastActive.getTime() > staleThreshold) {
      logEvent("stale-connection-cleanup", socketId);
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.disconnect(true);
      } else {
        connectionManager.removeUser(socketId);
      }
    }
  });
}, 60000);

app.get("/health", (req, res) => {
  res
    .status(200)
    .json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Error handling for the server
server.on("error", (error) => {
  console.error("Server error:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

io.engine.on("connection_error", (err) => {
  console.error("Connection error:", {
    code: err.code,
    message: err.message,
    context: err.context,
    timestamp: new Date().toISOString(),
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

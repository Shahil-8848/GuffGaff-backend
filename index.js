const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const debug = require("debug")("webrtc:server");

// Enhanced configuration with proper defaults
const config = {
  PORT: process.env.PORT || 3001,
  NODE_ENV: process.env.NODE_ENV || "production",
  CORS_ORIGIN: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["https://localhost:5173"],
  SOCKET_TIMEOUT: parseInt(process.env.SOCKET_TIMEOUT) || 60000,
  PING_INTERVAL: parseInt(process.env.PING_INTERVAL) || 25000,
  PING_TIMEOUT: parseInt(process.env.PING_TIMEOUT) || 10000,
  MAX_CLIENTS: parseInt(process.env.MAX_CLIENTS) || 1000,
  CLEANUP_INTERVAL: parseInt(process.env.CLEANUP_INTERVAL) || 300000,
  MAX_RECONNECT_ATTEMPTS: 3,
  INACTIVE_TIMEOUT: 5 * 60 * 1000, // 5 minutes
};

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Enhanced security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "wss:", "https:"],
        mediaSrc: ["'self'", "blob:"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Trust proxy for secure headers
app.set("trust proxy", 1);

// Enhanced CORS with proper error handling
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = config.CORS_ORIGIN;
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  methods: ["GET", "POST"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Rate limiting with enhanced configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    debug("Rate limit exceeded:", req.ip);
    res.status(429).json({
      error: "Too many requests, please try again later.",
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000),
    });
  },
});

app.use(limiter);

class ConnectionManager {
  constructor(io) {
    this.io = io;
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.lastCleanup = Date.now();

    // Periodic cleanup of stale connections
    setInterval(() => this.cleanup(), config.CLEANUP_INTERVAL);
  }

  cleanup() {
    const now = Date.now();
    debug("Running cleanup...");

    for (const [socketId, user] of this.users.entries()) {
      if (now - user.lastActive > config.INACTIVE_TIMEOUT) {
        debug(`Cleaning up inactive user: ${socketId}`);
        this.removeUser(socketId);
      }
    }

    this.lastCleanup = now;
    this.broadcastStats();
  }

  addUser(socketId) {
    if (this.users.size >= config.MAX_CLIENTS) {
      throw new Error("Server at capacity");
    }

    this.users.set(socketId, {
      inCall: false,
      connectedAt: Date.now(),
      lastActive: Date.now(),
      room: null,
      connectionAttempts: 0,
    });

    this.broadcastStats();
    debug(`User added: ${socketId}`);
  }

  findMatch(socketId) {
    debug(`Finding match for ${socketId}`);

    if (this.partnerships.has(socketId)) {
      this.breakPartnership(socketId);
    }

    this.removeFromWaitingQueue(socketId);
    const waitingPartnerId = this.getNextWaitingUser();

    if (waitingPartnerId) {
      const { roomId, success } = this.createPartnership(
        socketId,
        waitingPartnerId
      );
      if (success) {
        return { matched: true, partnerId: waitingPartnerId, roomId };
      }
    }

    this.addToWaitingQueue(socketId);
    return { matched: false };
  }

  createPartnership(socket1Id, socket2Id) {
    try {
      const roomId = `room_${++this.roomCounter}_${Date.now()}`;

      // Update partnerships
      this.partnerships.set(socket1Id, { partnerId: socket2Id, roomId });
      this.partnerships.set(socket2Id, { partnerId: socket1Id, roomId });

      // Update user states
      const user1 = this.users.get(socket1Id);
      const user2 = this.users.get(socket2Id);

      if (user1 && user2) {
        user1.inCall = true;
        user2.inCall = true;
        user1.room = roomId;
        user2.room = roomId;
        user1.lastActive = Date.now();
        user2.lastActive = Date.now();
      }

      this.broadcastStats();
      debug(
        `Partnership created: ${socket1Id} <-> ${socket2Id} in room ${roomId}`
      );
      return { roomId, success: true };
    } catch (error) {
      debug("Partnership creation error:", error);
      return { success: false, error: "Failed to create partnership" };
    }
  }

  breakPartnership(socketId) {
    const partnership = this.partnerships.get(socketId);
    if (!partnership) return null;

    const { partnerId, roomId } = partnership;

    // Update user states
    const partnerUser = this.users.get(partnerId);
    const user = this.users.get(socketId);

    if (partnerUser) {
      partnerUser.inCall = false;
      partnerUser.room = null;
      partnerUser.lastActive = Date.now();
    }

    if (user) {
      user.inCall = false;
      user.room = null;
      user.lastActive = Date.now();
    }

    // Clean up partnerships
    this.partnerships.delete(partnerId);
    this.partnerships.delete(socketId);

    this.broadcastStats();
    debug(`Partnership broken: ${socketId} <-> ${partnerId}`);
    return { partnerId, roomId };
  }

  removeUser(socketId) {
    this.breakPartnership(socketId);
    this.removeFromWaitingQueue(socketId);
    this.users.delete(socketId);
    this.broadcastStats();
    debug(`User removed: ${socketId}`);
  }

  addToWaitingQueue(socketId) {
    if (!this.waitingQueue.includes(socketId)) {
      this.waitingQueue.push(socketId);
      const user = this.users.get(socketId);
      if (user) {
        user.lastActive = Date.now();
      }
      debug(`Added to waiting queue: ${socketId}`);
      return true;
    }
    return false;
  }

  removeFromWaitingQueue(socketId) {
    const index = this.waitingQueue.indexOf(socketId);
    if (index !== -1) {
      this.waitingQueue.splice(index, 1);
      debug(`Removed from waiting queue: ${socketId}`);
    }
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

  getStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
      uptime: process.uptime(),
      lastCleanup: this.lastCleanup,
    };
  }

  broadcastStats() {
    this.io.emit("stats-update", this.getStats());
  }

  updateUserActivity(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      user.lastActive = Date.now();
    }
  }
}

// Socket.IO initialization with enhanced configuration
const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: config.PING_TIMEOUT,
  pingInterval: config.PING_INTERVAL,
  transports: ["websocket", "polling"],
  allowEIO3: true,
  maxHttpBufferSize: 1e6,
  connectTimeout: 45000,
  path: "/socket.io",
});

const connectionManager = new ConnectionManager(io);

// Socket connection handling with enhanced error handling
io.on("connection", (socket) => {
  try {
    debug(`New connection: ${socket.id}`);
    connectionManager.addUser(socket.id);

    socket.on("find-match", () => {
      try {
        connectionManager.updateUserActivity(socket.id);
        const { matched, partnerId, roomId } = connectionManager.findMatch(
          socket.id
        );

        if (matched && partnerId) {
          const matchData = {
            timestamp: Date.now(),
            roomId,
            matchId: `${socket.id.slice(0, 4)}-${partnerId.slice(0, 4)}`,
          };

          socket.emit("match", { ...matchData, peerId: partnerId });
          io.to(partnerId).emit("match", { ...matchData, peerId: socket.id });
        } else {
          socket.emit("waiting", {
            position: connectionManager.waitingQueue.length,
          });
        }
      } catch (error) {
        debug("Find match error:", error);
        socket.emit("error", { message: "Failed to find match" });
      }
    });

    // WebRTC signaling with enhanced validation
    socket.on("offer", ({ peerId, offer }) => {
      try {
        connectionManager.updateUserActivity(socket.id);
        const partnership = connectionManager.partnerships.get(socket.id);

        if (partnership && partnership.partnerId === peerId) {
          io.to(peerId).emit("offer", { offer, peerId: socket.id });
        }
      } catch (error) {
        debug("Offer error:", error);
      }
    });

    socket.on("answer", ({ peerId, answer }) => {
      try {
        connectionManager.updateUserActivity(socket.id);
        const partnership = connectionManager.partnerships.get(socket.id);

        if (partnership && partnership.partnerId === peerId) {
          io.to(peerId).emit("answer", { answer, peerId: socket.id });
        }
      } catch (error) {
        debug("Answer error:", error);
      }
    });

    socket.on("ice-candidate", ({ peerId, candidate }) => {
      try {
        connectionManager.updateUserActivity(socket.id);
        const partnership = connectionManager.partnerships.get(socket.id);

        if (partnership && partnership.partnerId === peerId) {
          io.to(peerId).emit("ice-candidate", { candidate, peerId: socket.id });
        }
      } catch (error) {
        debug("ICE candidate error:", error);
      }
    });

    socket.on("disconnect", () => {
      try {
        debug(`Disconnection: ${socket.id}`);
        const partnership = connectionManager.breakPartnership(socket.id);
        if (partnership) {
          io.to(partnership.partnerId).emit("partner-left");
        }
        connectionManager.removeUser(socket.id);
      } catch (error) {
        debug("Disconnect error:", error);
      }
    });
  } catch (error) {
    debug("Connection error:", error);
    socket.emit("error", { message: "Connection failed" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  try {
    const stats = connectionManager.getStats();
    res.status(200).json({
      status: "healthy",
      timestamp: Date.now(),
      ...stats,
    });
  } catch (error) {
    debug("Health check error:", error);
    res.status(500).json({ status: "unhealthy", error: error.message });
  }
});

// Global error handlers
process.on("uncaughtException", (error) => {
  debug("Uncaught Exception:", error);
  // Implement graceful shutdown if needed
});

process.on("unhandledRejection", (reason, promise) => {
  debug("Unhandled Rejection at:", promise, "reason:", reason);
  // Implement graceful shutdown if needed
});

// Start server
server.listen(config.PORT, () => {
  debug(`
🚀 Server Status:
- Environment: ${config.NODE_ENV}
- Port: ${config.PORT}
- CORS Origins: ${config.CORS_ORIGIN.join(", ")}
- Max Clients: ${config.MAX_CLIENTS}
- WebSocket: Ready
  `);
});

module.exports = { app, server, io };

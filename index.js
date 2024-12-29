const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const debug = require("debug")("webrtc:server");

// Environment variables with defaults
const config = {
  PORT: process.env.PORT || 3001,
  NODE_ENV: process.env.NODE_ENV || "production",
  CORS_ORIGIN: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["https://localhost:5173"],
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  SOCKET_TIMEOUT: parseInt(process.env.SOCKET_TIMEOUT) || 60000,
  PING_INTERVAL: parseInt(process.env.PING_INTERVAL) || 25000,
  PING_TIMEOUT: parseInt(process.env.PING_TIMEOUT) || 10000,
  MAX_CLIENTS: parseInt(process.env.MAX_CLIENTS) || 1000,
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
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Trust proxy settings for secure headers
app.set("trust proxy", 1);

// Enhanced CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins =
      config.NODE_ENV === "production"
        ? config.CORS_ORIGIN
        : [
            "https://localhost:5173",
            "http://localhost:5173",
            ...config.CORS_ORIGIN,
          ];

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Rate limiting with enhanced configuration
const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW,
  max: config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many requests, please try again later." },
  keyGenerator: (req) => req.ip,
});

app.use(limiter);

// Socket.IO initialization with enhanced configuration
const io = new Server(server, {
  cors: corsOptions,
  transports: ["polling", "websocket"],
  allowEIO3: true,
  pingTimeout: config.PING_TIMEOUT,
  pingInterval: config.PING_INTERVAL,
  path: "/socket.io",
  connectionStateRecovery: {
    maxDisconnectionDuration: 2000,
    skipMiddlewares: true,
  },
  maxHttpBufferSize: 1e6, // 1 MB
  connectTimeout: 45000,
});

// Enhanced Connection Manager with error handling and monitoring
class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.lastCleanup = Date.now();
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // 5 minutes
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
    this.broadcastActiveUsers();
  }

  cleanup() {
    const now = Date.now();
    const inactiveTimeout = 300000; // 5 minutes

    for (const [socketId, user] of this.users.entries()) {
      if (now - user.lastActive > inactiveTimeout) {
        this.removeUser(socketId);
      }
    }

    this.lastCleanup = now;
  }

  addToWaitingQueue(socketId) {
    if (this.waitingQueue.includes(socketId)) return false;

    const user = this.users.get(socketId);
    if (!user) return false;

    this.waitingQueue.push(socketId);
    user.lastActive = Date.now();
    return true;
  }

  removeUser(socketId) {
    this.users.delete(socketId);
    this.removeFromWaitingQueue(socketId);
    this.broadcastActiveUsers();
  }

  createPartnership(socket1Id, socket2Id) {
    try {
      const roomId = `room_${++this.roomCounter}_${Date.now()}`;
      this.partnerships.set(socket1Id, { partnerId: socket2Id, roomId });
      this.partnerships.set(socket2Id, { partnerId: socket1Id, roomId });

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

    this.partnerships.delete(partnerId);
    this.partnerships.delete(socketId);

    return { partnerId, roomId };
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
  broadcastActiveUsers() {
    const activeUsers = this.users.size;
    io.emit("active-users", activeUsers);
  }
}

const connectionManager = new ConnectionManager();

// Enhanced logging middleware
const logEvent = (event, socketId, data = {}) => {
  debug(`[${new Date().toISOString()}] ${event} | Socket: ${socketId}`, data);
};

// Socket connection handling with enhanced error handling
io.on("connection", (socket) => {
  try {
    connectionManager.addUser(socket.id);
    logEvent("connection", socket.id);

    // Broadcast updated stats
    io.emit("stats-update", connectionManager.getStats());

    // Enhanced error handling for socket events
    socket.on("error", (error) => {
      logEvent("error", socket.id, error);
      socket.emit("error", { message: "An error occurred" });
    });

    socket.on("find-match", () => {
      try {
        const oldPartnership = connectionManager.breakPartnership(socket.id);
        if (oldPartnership) {
          io.to(oldPartnership.partnerId).emit("partner-left");
        }

        const waitingPartnerId = connectionManager.getNextWaitingUser();
        if (waitingPartnerId) {
          const { roomId, success } = connectionManager.createPartnership(
            socket.id,
            waitingPartnerId
          );

          if (success) {
            const matchData = {
              timestamp: Date.now(),
              roomId,
              matchId: `${socket.id.slice(0, 4)}-${waitingPartnerId.slice(
                0,
                4
              )}`,
            };

            socket.emit("match", { ...matchData, peerId: waitingPartnerId });
            io.to(waitingPartnerId).emit("match", {
              ...matchData,
              peerId: socket.id,
            });
          }
        } else {
          connectionManager.addToWaitingQueue(socket.id);
          socket.emit("waiting", {
            position: connectionManager.waitingQueue.length,
          });
        }

        io.emit("stats-update", connectionManager.getStats());
      } catch (error) {
        logEvent("find-match-error", socket.id, error);
        socket.emit("error", { message: "Failed to find match" });
      }
    });

    // WebRTC signaling events with enhanced error handling
    socket.on("offer", ({ peerId, offer }) => {
      try {
        const partnership = connectionManager.partnerships.get(socket.id);
        if (partnership && partnership.partnerId === peerId) {
          io.to(peerId).emit("offer", { offer, peerId: socket.id });
        }
      } catch (error) {
        logEvent("offer-error", socket.id, error);
      }
    });

    socket.on("answer", ({ peerId, answer }) => {
      try {
        const partnership = connectionManager.partnerships.get(socket.id);
        if (partnership && partnership.partnerId === peerId) {
          io.to(peerId).emit("answer", { answer, peerId: socket.id });
        }
      } catch (error) {
        logEvent("answer-error", socket.id, error);
      }
    });

    socket.on("ice-candidate", ({ peerId, candidate }) => {
      try {
        const partnership = connectionManager.partnerships.get(socket.id);
        if (partnership && partnership.partnerId === peerId) {
          io.to(peerId).emit("ice-candidate", { candidate, peerId: socket.id });
        }
      } catch (error) {
        logEvent("ice-candidate-error", socket.id, error);
      }
    });

    socket.on("disconnect", () => {
      try {
        const partnership = connectionManager.breakPartnership(socket.id);
        if (partnership) {
          io.to(partnership.partnerId).emit("partner-left");
        }
        connectionManager.removeUser(socket.id);
        io.emit("stats-update", connectionManager.getStats());
      } catch (error) {
        logEvent("disconnect-error", socket.id, error);
      }
    });
  } catch (error) {
    logEvent("connection-error", socket.id, error);
    socket.emit("error", { message: "Connection failed" });
  }
});

// Health check endpoint with enhanced monitoring
app.get("/health", (req, res) => {
  try {
    const stats = connectionManager.getStats();
    res.status(200).json({
      status: "healthy",
      timestamp: Date.now(),
      ...stats,
    });
  } catch (error) {
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

// Start server with enhanced logging
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

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

// Environment variables with defaults
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
  : ["https://localhost:5173"];
const NODE_ENV = process.env.NODE_ENV || "production";
const RATE_LIMIT_WINDOW =
  parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Security middleware configuration
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.set("trust proxy", "loopback");

// CORS configuration
const corsOptions = {
  origin: NODE_ENV === "production" ? CORS_ORIGIN : "*",
  methods: ["GET", "POST"],
  credentials: true,
};
app.use(cors(corsOptions));

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: false,
});
app.use(limiter);

// Connection Manager Class
class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
  }

  addUser(socketId) {
    if (!this.users.has(socketId)) {
      this.users.set(socketId, {
        inCall: false,
        room: null,
        connectedAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
      });
      return true;
    }
    return false;
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
    return this.waitingQueue.shift() || null;
  }

  createPartnership(socket1Id, socket2Id) {
    try {
      const roomId = `room_${++this.roomCounter}`;

      // Set up partnerships
      this.partnerships.set(socket1Id, socket2Id);
      this.partnerships.set(socket2Id, socket1Id);

      // Create room
      this.rooms.set(roomId, {
        participants: [socket1Id, socket2Id],
        createdAt: new Date().toISOString(),
      });

      // Update user states
      const user1 = this.users.get(socket1Id);
      const user2 = this.users.get(socket2Id);

      if (user1 && user2) {
        user1.inCall = true;
        user2.inCall = true;
        user1.room = roomId;
        user2.room = roomId;
      }

      return roomId;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error creating partnership:`,
        error
      );
      return null;
    }
  }

  breakPartnership(socketId) {
    try {
      const partnerId = this.partnerships.get(socketId);
      if (partnerId) {
        const user = this.users.get(socketId);
        const partnerUser = this.users.get(partnerId);

        if (user && user.room) {
          this.rooms.delete(user.room);
        }

        // Clean up user states
        [user, partnerUser].forEach((u) => {
          if (u) {
            u.inCall = false;
            u.room = null;
          }
        });

        // Remove partnerships
        this.partnerships.delete(socketId);
        this.partnerships.delete(partnerId);
        return partnerId;
      }
      return null;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error breaking partnership:`,
        error
      );
      return null;
    }
  }

  validatePeers(fromPeerId, toPeerId) {
    try {
      // Find room containing fromPeerId
      for (const [roomId, room] of this.rooms) {
        if (room.participants.includes(fromPeerId)) {
          // Verify toPeerId is the other participant
          if (room.participants.includes(toPeerId)) {
            return { roomId, participants: room.participants };
          }
        }
      }
      return null;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error validating peers:`,
        error
      );
      return null;
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

// Initialize Socket.IO
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/socket.io",
  connectTimeout: 45000,
  maxHttpBufferSize: 1e6,
});

// Initialize connection manager
const connectionManager = new ConnectionManager();

// Socket connection handling
io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] New connection: ${socket.id}`);

  connectionManager.addUser(socket.id);
  io.emit("stats-update", connectionManager.getConnectionStats());

  socket.on("find-match", () => {
    console.log(
      `[${new Date().toISOString()}] Find match request from: ${socket.id}`
    );

    const waitingPartnerId = connectionManager.getNextWaitingUser();

    if (waitingPartnerId) {
      const roomId = connectionManager.createPartnership(
        socket.id,
        waitingPartnerId
      );

      if (!roomId) {
        socket.emit("error", { message: "Failed to create partnership" });
        return;
      }

      const matchData = {
        timestamp: new Date().toISOString(),
        roomId,
        matchId: `${socket.id.slice(0, 4)}-${waitingPartnerId.slice(0, 4)}`,
      };

      socket.emit("match", {
        ...matchData,
        peerId: waitingPartnerId,
        isInitiator: true,
      });

      io.to(waitingPartnerId).emit("match", {
        ...matchData,
        peerId: socket.id,
        isInitiator: false,
      });

      console.log(
        `[${new Date().toISOString()}] Match created: ${
          socket.id
        } with ${waitingPartnerId}`
      );
    } else {
      connectionManager.addToWaitingQueue(socket.id);
      socket.emit("waiting");
    }

    io.emit("stats-update", connectionManager.getConnectionStats());
  });

  // Handle WebRTC signaling
  socket.on("offer", ({ peerId, offer }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room) {
      socket.emit("error", { message: "Invalid peer relationship for offer" });
      return;
    }

    io.to(peerId).emit("offer", {
      offer,
      fromPeerId: socket.id,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("answer", ({ peerId, answer }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room) {
      socket.emit("error", { message: "Invalid peer relationship for answer" });
      return;
    }

    io.to(peerId).emit("answer", {
      answer,
      fromPeerId: socket.id,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("ice-candidate", ({ peerId, candidate }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room) {
      socket.emit("error", {
        message: "Invalid peer relationship for ICE candidate",
      });
      return;
    }

    io.to(peerId).emit("ice-candidate", {
      candidate,
      fromPeerId: socket.id,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("disconnect", () => {
    console.log(`[${new Date().toISOString()}] Disconnection: ${socket.id}`);

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
    environment: NODE_ENV,
  });
});

// Error handling for WebSocket upgrades
server.on("upgrade", (request, socket, head) => {
  socket.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] Socket upgrade error:`, err);
  });
});

// Handle connection errors
io.engine.on("connection_error", (err) => {
  console.error(`[${new Date().toISOString()}] Connection error:`, err);
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
  console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    `[${new Date().toISOString()}] Unhandled Rejection at:`,
    promise,
    "reason:",
    reason
  );
});

module.exports = { app, server, io };

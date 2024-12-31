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

// Socket.IO setup with improved configuration
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/socket.io",
  connectTimeout: 45000,
  maxHttpBufferSize: 1e6,
});

// Enhanced Connection Manager Class
class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
    this.connectionTimeouts = new Map();
    this.maxConnectionAttempts = 3;
    this.connectionTimeout = 30000; // 30 seconds
  }

  addUser(socketId) {
    this.users.set(socketId, {
      id: socketId,
      inCall: false,
      room: null,
      joinedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      connectionAttempts: 0,
      signalingState: "new",
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
    const user = this.users.get(socketId);
    if (!user) return false;

    if (!this.waitingQueue.includes(socketId)) {
      this.waitingQueue.push(socketId);
      user.lastActive = new Date().toISOString();
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
    while (this.waitingQueue.length > 0) {
      const nextUserId = this.waitingQueue.shift();
      const user = this.users.get(nextUserId);

      if (user && !user.inCall) {
        return nextUserId;
      }
    }
    return null;
  }

  createPartnership(socket1Id, socket2Id) {
    // Clear any existing partnerships
    this.breakPartnership(socket1Id);
    this.breakPartnership(socket2Id);

    const roomId = `room_${++this.roomCounter}`;

    // Create room with enhanced metadata
    this.rooms.set(roomId, {
      id: roomId,
      participants: [socket1Id, socket2Id],
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      state: "connecting",
      connectionAttempts: 0,
      signalingState: {
        [socket1Id]: "new",
        [socket2Id]: "new",
      },
      iceCandidates: {
        [socket1Id]: [],
        [socket2Id]: [],
      },
    });

    // Set up partnerships
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

    // Set connection timeout
    this.setConnectionTimeout(roomId);

    return roomId;
  }

  setConnectionTimeout(roomId) {
    if (this.connectionTimeouts.has(roomId)) {
      clearTimeout(this.connectionTimeouts.get(roomId));
    }

    const timeout = setTimeout(() => {
      const room = this.rooms.get(roomId);
      if (room && room.state === "connecting") {
        room.state = "failed";
        room.participants.forEach((participantId) => {
          const user = this.users.get(participantId);
          if (user) {
            user.connectionAttempts += 1;
            user.inCall = false;
            user.room = null;
          }
        });
        this.breakPartnership(room.participants[0]);
      }
    }, this.connectionTimeout);

    this.connectionTimeouts.set(roomId, timeout);
  }

  findRoomByPeerId(peerId) {
    const user = this.users.get(peerId);
    if (!user || !user.room) return null;

    const room = this.rooms.get(user.room);
    if (!room) return null;

    return {
      roomId: room.id,
      participants: room.participants,
      state: room.state,
    };
  }

  updateRoomState(roomId, state, peerId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.lastActivity = new Date().toISOString();

      if (peerId) {
        room.signalingState[peerId] = state;
      }

      if (state === "connected") {
        room.state = "active";
        if (this.connectionTimeouts.has(roomId)) {
          clearTimeout(this.connectionTimeouts.get(roomId));
          this.connectionTimeouts.delete(roomId);
        }
      }
    }
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

      if (user) {
        user.inCall = false;
        user.room = null;
        user.signalingState = "new";
      }
      if (partnerUser) {
        partnerUser.inCall = false;
        partnerUser.room = null;
        partnerUser.signalingState = "new";
      }

      this.partnerships.delete(socketId);
      this.partnerships.delete(partnerId);
      return partnerId;
    }
    return null;
  }

  getConnectionStats() {
    const activeRooms = Array.from(this.rooms.values()).filter(
      (room) => room.state === "active"
    );

    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: activeRooms.length,
      failedConnections: Array.from(this.rooms.values()).filter(
        (room) => room.state === "failed"
      ).length,
    };
  }
}

// Initialize connection manager
const connectionManager = new ConnectionManager();

// Enhanced logging middleware
const logEvent = (event, socketId, data = {}) => {
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] ${event} | Socket: ${socketId} | Data:`,
    JSON.stringify(data)
  );
};

// Socket.IO event handlers with improved error handling and logging
io.on("connection", (socket) => {
  logEvent("connection", socket.id);

  connectionManager.addUser(socket.id);
  io.emit("stats-update", connectionManager.getConnectionStats());

  // Handle find match request
  socket.on("find-match", () => {
    logEvent("find-match", socket.id);

    const waitingPartnerId = connectionManager.getNextWaitingUser();
    if (waitingPartnerId) {
      const roomId = connectionManager.createPartnership(
        socket.id,
        waitingPartnerId
      );

      // Emit match events with enhanced metadata
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
        matchData,
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

  // Handle WebRTC signaling with improved error handling
  socket.on("offer", ({ peerId, offer, fromPeerId }) => {
    logEvent("offer", socket.id, { toPeer: peerId });

    const room = connectionManager.findRoomByPeerId(fromPeerId);
    if (!room) {
      socket.emit("signaling-error", {
        type: "offer",
        message: "Room not found",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    connectionManager.updateRoomState(room.roomId, "offer-sent", fromPeerId);
    io.to(peerId).emit("offer", {
      offer,
      fromPeerId,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("answer", ({ peerId, answer, fromPeerId }) => {
    logEvent("answer", socket.id, { toPeer: peerId });

    const room = connectionManager.findRoomByPeerId(fromPeerId);
    if (!room) {
      socket.emit("signaling-error", {
        type: "answer",
        message: "Room not found",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    connectionManager.updateRoomState(room.roomId, "answer-sent", fromPeerId);
    io.to(peerId).emit("answer", {
      answer,
      fromPeerId,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("ice-candidate", ({ peerId, candidate, fromPeerId }) => {
    logEvent("ice-candidate", socket.id, { toPeer: peerId });

    const room = connectionManager.findRoomByPeerId(fromPeerId);
    if (!room) {
      socket.emit("signaling-error", {
        type: "ice-candidate",
        message: "Room not found",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const otherPeer = room.participants.find((p) => p !== fromPeerId);
    if (!otherPeer) {
      socket.emit("signaling-error", {
        type: "ice-candidate",
        message: "Peer not found in room",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    io.to(otherPeer).emit("ice-candidate", {
      candidate,
      fromPeerId,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle connection state updates
  socket.on("connection-state", ({ state, roomId }) => {
    logEvent("connection-state", socket.id, { state, roomId });
    connectionManager.updateRoomState(roomId, state, socket.id);
    io.emit("stats-update", connectionManager.getConnectionStats());
  });

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    logEvent("disconnect", socket.id, { reason });

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

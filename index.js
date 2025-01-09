const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Environment configuration
const environment = {
  PORT: process.env.PORT || 3001,
  CORS_ORIGIN: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["https://localhost:5173"],
  NODE_ENV: process.env.NODE_ENV || "production",
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 100,
};

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Security middleware setup
const setupSecurity = () => {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.set("trust proxy", "loopback");

  const corsOptions = {
    origin:
      environment.NODE_ENV === "production" ? environment.CORS_ORIGIN : "*",
    methods: ["GET", "POST"],
    credentials: true,
  };
  app.use(cors(corsOptions));

  app.use(
    rateLimit({
      windowMs: environment.RATE_LIMIT_WINDOW,
      max: environment.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      trustProxy: false,
    })
  );

  return corsOptions;
};

// Initialize Socket.IO with security settings
const corsOptions = setupSecurity();
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/socket.io",
  connectTimeout: 45000,
  maxHttpBufferSize: 1e6,
});

// User management
class UserManager {
  constructor() {
    this.users = new Map();
    this.waitingQueue = [];
  }

  addUser(socketId, userData) {
    this.users.set(socketId, {
      ...userData,
      inCall: false,
      room: null,
      connectedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
    });
  }

  removeUser(socketId) {
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
    }
  }

  getNextWaitingUser() {
    return this.waitingQueue.shift() || null;
  }

  getUserData(socketId) {
    return this.users.get(socketId);
  }

  getStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
    };
  }
}

// Chat room management
class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.partnerships = new Map();
    this.roomCounter = 0;
  }

  createRoom(socket1Id, socket2Id) {
    const roomId = `room_${++this.roomCounter}`;

    this.partnerships.set(socket1Id, socket2Id);
    this.partnerships.set(socket2Id, socket1Id);

    this.rooms.set(roomId, {
      participants: [socket1Id, socket2Id],
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      messages: [],
    });

    return roomId;
  }

  getPartner(socketId) {
    return this.partnerships.get(socketId);
  }

  getRoomByParticipant(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.includes(socketId)) {
        return roomId;
      }
    }
    return null;
  }

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.participants.forEach((participantId) => {
        this.partnerships.delete(participantId);
      });
      this.rooms.delete(roomId);
    }
  }

  addMessage(roomId, message) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.messages.push(message);
      room.lastActivity = new Date().toISOString();
      return true;
    }
    return false;
  }
}

// Initialize managers
const userManager = new UserManager();
const roomManager = new RoomManager();

// Socket connection handling
io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] New connection: ${socket.id}`);

  const userData = {
    socketId: socket.id,
    firestoreId: socket.handshake.query.firestoreId,
    userName: socket.handshake.query.userName,
    userPhoto: socket.handshake.query.userPhoto,
  };

  userManager.addUser(socket.id, userData);
  io.emit("stats-update", userManager.getStats());

  socket.on("find-match", () => {
    const waitingPartnerId = userManager.getNextWaitingUser();

    if (waitingPartnerId) {
      const roomId = roomManager.createRoom(socket.id, waitingPartnerId);
      const partnerData = userManager.getUserData(waitingPartnerId);

      socket.emit("match", {
        peerId: waitingPartnerId,
        peerFirestoreId: partnerData.firestoreId,
      });

      io.to(waitingPartnerId).emit("match", {
        peerId: socket.id,
        peerFirestoreId: userData.firestoreId,
      });
    } else {
      userManager.addToWaitingQueue(socket.id);
      socket.emit("waiting");
    }

    io.emit("stats-update", userManager.getStats());
  });

  socket.on("chat-message", (message) => {
    const roomId = roomManager.getRoomByParticipant(socket.id);
    if (roomId) {
      const partnerId = roomManager.getPartner(socket.id);
      if (partnerId) {
        const messageWithMetadata = {
          ...message,
          timestamp: new Date().toISOString(),
          fromId: socket.id,
        };

        roomManager.addMessage(roomId, messageWithMetadata);
        io.to(partnerId).emit("chat-message", messageWithMetadata);
        socket.emit("message-ack", message.id);
      }
    }
  });

  socket.on("disconnect", () => {
    const roomId = roomManager.getRoomByParticipant(socket.id);
    if (roomId) {
      const partnerId = roomManager.getPartner(socket.id);
      if (partnerId) {
        io.to(partnerId).emit("partner-left", {
          reason: "Partner disconnected",
          timestamp: new Date().toISOString(),
        });
      }
      roomManager.removeRoom(roomId);
    }

    userManager.removeUser(socket.id);
    io.emit("stats-update", userManager.getStats());
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    stats: userManager.getStats(),
    environment: environment.NODE_ENV,
  });
});

// Error handling
server.on("upgrade", (request, socket, head) => {
  socket.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] Socket upgrade error:`, err);
  });
});

io.engine.on("connection_error", (err) => {
  console.error(`[${new Date().toISOString()}] Connection error:`, err);
});

// Start server
server.listen(environment.PORT, () => {
  console.log(`
🚀 Server Status:
- Environment: ${environment.NODE_ENV}
- Port: ${environment.PORT}
- WebSocket: Ready
- Cors Origin: ${environment.CORS_ORIGIN}
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

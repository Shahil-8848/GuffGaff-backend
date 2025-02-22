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
  : ["http://localhost:5173", "https://your-firebase-app.web.app"]; // Update with your Firebase URL
const NODE_ENV = process.env.NODE_ENV || "production";
const RATE_LIMIT_WINDOW =
  parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;

// Initialize app and server
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: NODE_ENV === "production" ? CORS_ORIGIN : "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/video-chat",
  connectTimeout: 10000,
});

// Security middleware
app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false })
);
app.set("trust proxy", "loopback");
app.use(cors(io.options.cors));
app.use(rateLimit({ windowMs: RATE_LIMIT_WINDOW, max: RATE_LIMIT_MAX }));

// Connection Manager Class
class ConnectionManager {
  constructor() {
    this.users = new Map(); // socketId -> { inCall, room, connectedAt, lastActive }
    this.partnerships = new Map(); // socketId -> partnerSocketId
    this.waitingQueue = []; // socketIds waiting for a match
    this.rooms = new Map(); // roomId -> { participants, createdAt, lastActivity, messages, connected }
    this.connectionTimeouts = new Map(); // roomId -> timeoutId
    this.connectionTimeout = 15000; // 15s timeout
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
    if (user && user.room) this.breakPartnership(socketId);
    this.users.delete(socketId);
    this.removeFromWaitingQueue(socketId);
  }

  addToWaitingQueue(socketId) {
    if (!this.waitingQueue.includes(socketId) && this.users.has(socketId)) {
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

  getNextWaitingUser(socket) {
    while (this.waitingQueue.length > 0) {
      const nextUser = this.waitingQueue.shift();
      if (this.users.has(nextUser) && socket.connected) return nextUser;
    }
    return null;
  }

  createPartnership(socket1Id, socket2Id, io) {
    try {
      const socket1 = io.sockets.sockets.get(socket1Id);
      const socket2 = io.sockets.sockets.get(socket2Id);
      if (!socket1 || !socket2)
        throw new Error("One or both sockets disconnected");

      const roomId = `room_${Date.now()}_${++this.roomCounter}`;
      this.partnerships.set(socket1Id, socket2Id);
      this.partnerships.set(socket2Id, socket1Id);
      this.rooms.set(roomId, {
        participants: [socket1Id, socket2Id],
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        messages: [],
        connected: false,
      });

      const user1 = this.users.get(socket1Id);
      const user2 = this.users.get(socket2Id);
      if (user1 && user2) {
        user1.inCall = true;
        user2.inCall = true;
        user1.room = roomId;
        user2.room = roomId;
      }

      const timeoutId = setTimeout(() => {
        if (this.rooms.has(roomId) && !this.rooms.get(roomId).connected) {
          console.log(
            `[${new Date().toISOString()}] Timeout for room ${roomId}`
          );
          this.breakPartnership(socket1Id);
        }
      }, this.connectionTimeout);

      this.connectionTimeouts.set(roomId, timeoutId);
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
      if (!partnerId) return null;

      const user = this.users.get(socketId);
      if (user?.room) {
        const timeoutId = this.connectionTimeouts.get(user.room);
        if (timeoutId) {
          clearTimeout(timeoutId);
          this.connectionTimeouts.delete(user.room);
        }
        this.rooms.delete(user.room);
      }

      const partnerUser = this.users.get(partnerId);
      [user, partnerUser].forEach((u) => {
        if (u) {
          u.inCall = false;
          u.room = null;
        }
      });

      this.partnerships.delete(socketId);
      this.partnerships.delete(partnerId);
      return partnerId;
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error breaking partnership:`,
        error
      );
      return null;
    }
  }

  validatePeers(fromPeerId, toPeerId) {
    for (const [roomId, room] of this.rooms) {
      if (
        room.participants.includes(fromPeerId) &&
        room.participants.includes(toPeerId)
      ) {
        return { roomId, participants: room.participants };
      }
    }
    return null;
  }

  getRoomByParticipant(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.includes(socketId)) return roomId;
    }
    return null;
  }

  addMessageToRoom(roomId, message) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.messages.push({ ...message, timestamp: new Date().toISOString() });
      room.lastActivity = new Date().toISOString();
      return true;
    }
    return false;
  }

  markRoomConnected(roomId) {
    const room = this.rooms.get(roomId);
    if (room) room.connected = true;
  }

  getConnectionStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
    };
  }
}

// Connection Manager instance
const connectionManager = new ConnectionManager();

// Socket.IO handling
io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] New connection: ${socket.id}`);
  connectionManager.addUser(socket.id);
  io.emit("stats-update", connectionManager.getConnectionStats());

  socket.on("find-match", () => {
    console.log(
      `[${new Date().toISOString()}] Find match request: ${socket.id}`
    );
    const waitingPartnerId = connectionManager.getNextWaitingUser(socket);
    if (waitingPartnerId) {
      const roomId = connectionManager.createPartnership(
        socket.id,
        waitingPartnerId,
        io
      );
      if (!roomId) {
        socket.emit("error", { message: "Failed to create partnership" });
        return;
      }
      const matchData = { roomId, peerId: waitingPartnerId, isInitiator: true };
      socket.emit("match", matchData);
      io.to(waitingPartnerId).emit("match", {
        ...matchData,
        peerId: socket.id,
        isInitiator: false,
      });
      console.log(
        `[${new Date().toISOString()}] Match created: ${
          socket.id
        } <-> ${waitingPartnerId}`
      );
    } else {
      connectionManager.addToWaitingQueue(socket.id);
      socket.emit("waiting");
    }
    io.emit("stats-update", connectionManager.getConnectionStats());
  });

  socket.on("offer", ({ peerId, offer }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room)
      return socket.emit("error", { message: "Invalid peer relationship" });
    io.to(peerId).emit("offer", {
      offer,
      fromPeerId: socket.id,
      roomId: room.roomId,
    });
  });

  socket.on("answer", ({ peerId, answer }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room)
      return socket.emit("error", { message: "Invalid peer relationship" });
    io.to(peerId).emit("answer", {
      answer,
      fromPeerId: socket.id,
      roomId: room.roomId,
    });
  });

  socket.on("ice-candidate", ({ peerId, candidate }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room)
      return socket.emit("error", { message: "Invalid peer relationship" });
    console.log(
      `[${new Date().toISOString()}] ICE candidate from ${
        socket.id
      } to ${peerId}:`,
      candidate
    );
    io.to(peerId).emit("ice-candidate", {
      candidate,
      fromPeerId: socket.id,
      roomId: room.roomId,
    });
  });

  socket.on("chat-message", (message) => {
    const roomId = connectionManager.getRoomByParticipant(socket.id);
    if (!roomId) return socket.emit("error", { message: "Not in a room" });
    const room = connectionManager.rooms.get(roomId);
    if (room) {
      const recipient = room.participants.find((id) => id !== socket.id);
      if (recipient) {
        connectionManager.addMessageToRoom(roomId, {
          fromId: socket.id,
          text: message.text,
        });
        io.to(recipient).emit("chat-message", {
          fromId: socket.id,
          text: message.text,
          timestamp: new Date().toISOString(),
        });
      }
    }
  });

  socket.on("connected", (roomId) => {
    connectionManager.markRoomConnected(roomId);
    console.log(`[${new Date().toISOString()}] Room ${roomId} connected`);
  });

  socket.on("disconnect", () => {
    console.log(`[${new Date().toISOString()}] Disconnection: ${socket.id}`);
    const partnerId = connectionManager.breakPartnership(socket.id);
    if (partnerId)
      io.to(partnerId).emit("partner-left", { reason: "Partner disconnected" });
    connectionManager.removeUser(socket.id);
    io.emit("stats-update", connectionManager.getConnectionStats());
  });
});

// Health check endpoint
app.get("/health", (req, res) =>
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    stats: connectionManager.getConnectionStats(),
  })
);

// Error handlers
server.on("error", (err) =>
  console.error(`[${new Date().toISOString()}] Server error:`, err)
);
process.on("uncaughtException", (err) =>
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err)
);

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} in ${NODE_ENV} mode`);
});

module.exports = { app, server, io };

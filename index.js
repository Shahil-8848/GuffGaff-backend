const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { setupTextChatServer } = require("./server/textChat/textChatServer");
const fetch = require("node-fetch"); // npm i node-fetch@2

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
app.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: false,
  })
);

// Xirsys ICE Servers Endpoint
app.get("/ice-servers", async (req, res) => {
  try {
    const body = JSON.stringify({ format: "urls" });
    const response = await fetch("https://global.xirsys.net/_turn/GuffGaff", {
      method: "PUT", // Changed to PUT per Xirsys example
      headers: {
        Authorization:
          "Basic " +
          Buffer.from("Shahil:5f72cf7e-faa8-11ef-8604-0242ac130006").toString(
            "base64"
          ),
        "Content-Type": "application/json",
        "Content-Length": body.length, // Added per Xirsys example
      },
      body: body, // Added body with format: "urls"
    });

    const data = await response.json();
    console.log(
      `[${new Date().toISOString()}] Xirsys response straight to the client`,
      JSON.stringify(data, null, 2)
    );

    if (data.s !== "ok") {
      throw new Error("Xirsys API error: " + (data.e || "Unknown error"));
    }

    res.json(data.v.iceServers);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Xirsys fetch error:`,
      error.message
    );
    res.status(500).json({ error: "Failed to fetch ICE servers" });
  }
});
// Connection Manager Class
class ConnectionManager {
  constructor() {
    this.users = new Map();
    this.partnerships = new Map();
    this.waitingQueue = [];
    this.roomCounter = 0;
    this.rooms = new Map();
    this.connectionTimeouts = new Map();
    this.maxConnectionAttempts = 3;
    this.connectionTimeout = 10000; // Reduced to 10s
    this.queueLock = false;
  }

  addUser(socketId) {
    if (!this.users.has(socketId)) {
      this.users.set(socketId, {
        inCall: false,
        room: null,
        connectedAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        connectionAttempts: 0,
        alive: true, // Heartbeat flag
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
    if (
      !this.waitingQueue.includes(socketId) &&
      this.users.get(socketId)?.alive
    ) {
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
    if (this.queueLock) return null;
    this.queueLock = true;
    let nextUser = null;
    while (this.waitingQueue.length > 0) {
      nextUser = this.waitingQueue.shift();
      if (this.users.get(nextUser)?.alive) break;
      nextUser = null;
    }
    this.queueLock = false;
    return nextUser;
  }

  createPartnership(socket1Id, socket2Id) {
    try {
      const roomId = `room_${++this.roomCounter}`;
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
            `[${new Date().toISOString()}] Partnership timeout for room ${roomId}`
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
      if (partnerId) {
        const user = this.users.get(socketId);
        const partnerUser = this.users.get(partnerId);

        if (user && user.room) {
          const timeoutId = this.connectionTimeouts.get(user.room);
          if (timeoutId) {
            clearTimeout(timeoutId);
            this.connectionTimeouts.delete(user.room);
          }
          this.rooms.delete(user.room);
        }

        [user, partnerUser].forEach((u) => {
          if (u) {
            u.inCall = false;
            u.room = null;
            u.connectionAttempts = 0;
          }
        });

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
      for (const [roomId, room] of this.rooms) {
        if (
          room.participants.includes(fromPeerId) &&
          room.participants.includes(toPeerId)
        ) {
          return { roomId, participants: room.participants };
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

  getRoomByParticipant(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.participants.includes(socketId)) {
        return roomId;
      }
    }
    return null;
  }

  addMessageToRoom(roomId, message) {
    const room = this.rooms.get(roomId);
    if (room) {
      if (!room.messages) room.messages = [];
      room.messages.push(message);
      room.lastActivity = new Date().toISOString();
      return true;
    }
    return false;
  }

  getConnectionStats() {
    return {
      totalUsers: this.users.size,
      waitingUsers: this.waitingQueue.length,
      activePartnerships: this.partnerships.size / 2,
    };
  }

  markRoomConnected(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.connected = true;
      clearTimeout(this.connectionTimeouts.get(roomId));
      this.connectionTimeouts.delete(roomId);
    }
  }
}

// Initialize video Socket.IO
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/video-chat",
  connectTimeout: 60000,
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
    console.log(
      `[${new Date().toISOString()}] Raw ICE candidate from ${socket.id}:`,
      candidate
    );
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

  socket.on("connection-established", () => {
    const roomId = connectionManager.getRoomByParticipant(socket.id);
    if (roomId) connectionManager.markRoomConnected(roomId);
  });

  socket.on("chat-message", (message) => {
    const roomId = connectionManager.getRoomByParticipant(socket.id);
    if (roomId) {
      const room = connectionManager.rooms.get(roomId);
      if (room) {
        const recipient = room.participants.find((id) => id !== socket.id);
        if (recipient) {
          connectionManager.addMessageToRoom(roomId, {
            ...message,
            timestamp: new Date().toISOString(),
            fromId: socket.id,
          });
          io.to(recipient).emit("chat-message", {
            ...message,
            timestamp: new Date().toISOString(),
            fromId: socket.id,
          });
        }
      }
    }
  });

  socket.on("pong", () => {
    const user = connectionManager.users.get(socket.id);
    if (user) user.alive = true;
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

  // Heartbeat to ensure live users
  setInterval(() => {
    socket.emit("ping");
    setTimeout(() => {
      const user = connectionManager.users.get(socket.id);
      if (user && !user.alive) connectionManager.removeUser(socket.id);
      if (user) user.alive = false;
    }, 5000);
  }, 10000);
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

// Setup text chat server
const textChatIo = setupTextChatServer(server);

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

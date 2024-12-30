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
  allowEIO3: true, // Enable compatibility mode
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/socket.io",
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
    // console.log()
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
  console.log(`New connection: ${socket.id}`);

  connectionManager.addUser(socket.id);
  io.emit("stats-update", connectionManager.getConnectionStats());

  socket.on("error", (error) => {
    console.error(`Socket ${socket.id} error:`, error);
  });

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
      // The waiting user becomes the initiator
      socket.emit("match", {
        ...matchData,
        peerId: waitingPartnerId,
        isInitiator: false, // This user is the receiver
      });
      io.to(waitingPartnerId).emit("match", {
        ...matchData,
        peerId: socket.id,
        isInitiator: true, // Waiting user becomes initiator
      });
      logEvent("match-created", socket.id, {
        partnerId: waitingPartnerId,
        roomId,
        initiator: waitingPartnerId, // Log who is the initiator
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
    console.log(`Received offer from ${socket.id} for ${data.peerId}`);
    io.to(data.peerId).emit("offer", {
      offer: data.offer,
      peerId: socket.id,
    });
  });

  socket.on("answer", (data) => {
    logEvent("answer", socket.id, { peerId: data.peerId });
    console.log(`Received answer from ${socket.id} for ${data.peerId}`);
    io.to(data.peerId).emit("answer", {
      answer: data.answer,
      peerId: socket.id,
    });
  });

  socket.on("ice-candidate", (data) => {
    logEvent("ice-candidate", socket.id, { peerId: data.peerId });
    console.log(`Received ICE candidate from ${socket.id} for ${data.peerId}`);
    io.to(data.peerId).emit("ice-candidate", {
      candidate: data.candidate,
      peerId: socket.id,
    });
  });
  socket.on("chat-message", (message) => {
    logEvent("chat-message", socket.id, { message });
    const partnerId = connectionManager.partnerships.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("chat-message", {
        text: message.text,
        sender: socket.id,
        timestamp: new Date().toISOString(),
      });
    }
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
// Add this before your server.listen()
server.on("upgrade", (request, socket, head) => {
  socket.on("error", (err) => {
    console.error("Socket upgrade error:", err);
  });
});

// Adding  WebSocket specific logging
io.engine.on("connection_error", (err) => {
  console.error("Connection error:", err);
});
app.get("/socket-test", (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>WebSocket Test</h1>
        <div id="status">Connecting...</div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io({
            transports: ['websocket'],
            upgrade: false
          });
          
          socket.on('connect', () => {
            document.getElementById('status').textContent = 'Connected!';
          });
          
          socket.on('connect_error', (error) => {
            document.getElementById('status').textContent = 'Error: ' + error;
          });
        </script>
      </body>
    </html>
  `);
});
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

// Global error handler for uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Optionally, you can gracefully shut down your server here
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Optionally, you can gracefully shut down your server here
});

module.exports = { app, server, io };

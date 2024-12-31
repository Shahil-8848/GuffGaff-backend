const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const ConnectionManager = require("./connectionManager");
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
const connectionManager = new ConnectionManager();

const logEvent = (event, socketId, data = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${event} | Socket: ${socketId} | Data:`, data);
};

io.on("connection", (socket) => {
  logEvent("connection", socket.id);

  connectionManager.addUser(socket.id);
  io.emit("stats-update", connectionManager.getStats());

  socket.on("find-match", () => {
    logEvent("find-match", socket.id);

    const oldPartnerId = connectionManager.breakPartnership(socket.id);
    if (oldPartnerId) {
      io.to(oldPartnerId).emit("partner-left");
    }

    const waitingPartnerId = connectionManager.getNextWaitingUser();
    if (waitingPartnerId) {
      const roomId = connectionManager.createPartnership(
        socket.id,
        waitingPartnerId
      );

      socket.emit("match", {
        peerId: waitingPartnerId,
        isInitiator: false,
      });

      io.to(waitingPartnerId).emit("match", {
        peerId: socket.id,
        isInitiator: true,
      });

      logEvent("match-created", socket.id, {
        partnerId: waitingPartnerId,
        roomId,
      });
    } else {
      connectionManager.addToWaitingQueue(socket.id);
      socket.emit("waiting");
    }

    io.emit("stats-update", connectionManager.getStats());
  });

  socket.on("offer", ({ peerId, offer, fromPeerId }) => {
    logEvent("offer", socket.id, { toPeer: peerId });
    io.to(peerId).emit("offer", { offer, fromPeerId: socket.id });
  });

  socket.on("answer", ({ peerId, answer, fromPeerId }) => {
    logEvent("answer", socket.id, { toPeer: peerId });
    io.to(peerId).emit("answer", { answer, fromPeerId: socket.id });
  });

  socket.on("ice-candidate", ({ peerId, candidate, fromPeerId }) => {
    const room = connectionManager.findRoomByPeerId(peerId);
    if (!room) {
      console.warn(`No room found for peer ${peerId}`);
      return;
    }

    const otherPeer = room.participants.find((p) => p !== fromPeerId);
    if (!otherPeer) {
      console.warn(`No other peer found in room for ${fromPeerId}`);
      return;
    }

    io.to(otherPeer).emit("ice-candidate", {
      candidate,
      fromPeerId,
    });
  });

  socket.on("disconnect", (reason) => {
    logEvent("disconnect", socket.id, { reason });

    const partnerId = connectionManager.breakPartnership(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("partner-left");
    }

    connectionManager.removeUser(socket.id);
    io.emit("stats-update", connectionManager.getStats());
  });
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Log the error and continue running the server
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Log the error and continue running the server
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

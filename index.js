const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const {
  PORT,
  CORS_ORIGIN,
  NODE_ENV,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX,
  corsOptions,
  socketOptions,
} = require("./server/config/serverConfig");

const { ConnectionManager } = require("./server/services/ConnectionManager");
const {
  setupMatchmakingHandlers,
} = require("/server/socketHandlers/matchmakingHandler");
const {
  setupWebRTCHandlers,
} = require("./server/socketHandlers/webRTCHandler");
const { setupChatHandlers } = require("./server/socketHandlers/chatHandler");

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

// CORS and rate limiting configuration
app.use(cors(corsOptions));
app.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: false,
  })
);

// Initialize Socket.IO and connection manager
const io = new Server(server, socketOptions);
const connectionManager = new ConnectionManager();

// Socket connection handling
io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] New connection: ${socket.id}`);

  connectionManager.addUser(socket.id);
  io.emit("stats-update", connectionManager.getConnectionStats());

  // Set up all socket handlers
  setupMatchmakingHandlers(io, socket, connectionManager);
  setupWebRTCHandlers(io, socket, connectionManager);
  setupChatHandlers(io, socket, connectionManager);

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

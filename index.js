const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const environment = require("./server/config/environment");
const { configureMiddleware } = require("./server/config/middleWare");
const ConnectionManager = require("./server/services/ConnectionManager");
const MatchMaker = require("./server/services/MatchMaker");
const RoomManager = require("./server/services/RoomManager");

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Configure middleware and get CORS options
const corsOptions = configureMiddleware(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: corsOptions,
  transports: ["websocket"],
  pingTimeout: environment.SOCKET_PING_TIMEOUT,
  pingInterval: environment.SOCKET_PING_INTERVAL,
  path: environment.SOCKET_PATH,
  connectTimeout: environment.SOCKET_CONNECT_TIMEOUT,
  maxHttpBufferSize: environment.MAX_BUFFER_SIZE,
});

// Initialize services
const matchMaker = new MatchMaker();
const roomManager = new RoomManager();
const connectionManager = new ConnectionManager(io, matchMaker, roomManager);

// Socket connection handling
io.on("connection", (socket) => {
  connectionManager.handleNewConnection(socket);
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    stats: {
      totalUsers: io.engine.clientsCount,
      ...matchMaker.getWaitingQueueStats(),
      activeRooms: roomManager.getActiveRooms().length,
    },
    environment: environment.NODE_ENV,
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

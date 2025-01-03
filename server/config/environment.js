// export const PORT = process.env.PORT || 3001;
// export const CORS_ORIGIN = process.env.CORS_ORIGIN
//   ? process.env.CORS_ORIGIN.split(",")
//   : ["https://localhost:5173"];
// export const NODE_ENV = process.env.NODE_ENV || "production";
// export const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || `${15 * 60 * 1000}`);
// export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100");

// // export const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000;
// // export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;

// export const corsOptions = {
//   origin: NODE_ENV === "production" ? CORS_ORIGIN : "*",
//   methods: ["GET", "POST"],
//   credentials: true,
// };

// export const socketOptions = {
//   cors: corsOptions,
//   transports: ["websocket"],
//   pingTimeout: 60000,
//   pingInterval: 25000,
//   path: "/socket.io",
//   connectTimeout: 45000,
//   maxHttpBufferSize: 1e6,
// };

const environment = {
  PORT: process.env.PORT || 3001,
  CORS_ORIGIN: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["https://localhost:5173"],
  NODE_ENV: process.env.NODE_ENV || "production",
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  SOCKET_PING_TIMEOUT: 60000,
  SOCKET_PING_INTERVAL: 25000,
  SOCKET_PATH: "/socket.io",
  SOCKET_CONNECT_TIMEOUT: 45000,
  MAX_BUFFER_SIZE: 1e6,
};

module.exports = environment;

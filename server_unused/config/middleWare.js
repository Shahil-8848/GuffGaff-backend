const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const environment = require("./environment");
const configureMiddleware = (app) => {
  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.set("trust proxy", "loopback");
  // CORS configuration
  const corsOptions = {
    origin:
      environment.NODE_ENV === "production" ? environment.CORS_ORIGIN : "*",
    methods: ["GET", "POST"],
    credentials: true,
  };
  app.use(cors(corsOptions));
  // Rate limiting
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
module.exports = { configureMiddleware };

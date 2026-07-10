// app.js
require("dotenv").config();

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

// ─── Route Imports ───────────────────────────────────────────────────────────
const waAuthRoutes = require("./routes/waAuthRoutes");
const memberRoutes = require("./routes/members");
const reportRoutes = require("./routes/reports");
const transactionRoutes = require("./routes/transaction");
const orderRoutes = require("./routes/orders");
const paymentRoutes = require("./routes/payments");
const partnerAuthRoutes = require('./routes/partnerAuthRoutes');
const partnerRoutes = require('./routes/partnerRoutes');
const partnerWalletRoutes = require('./routes/partnerWalletRoutes');
const machineRechargeRoutes = require('./routes/machineRechargeRoutes');
const walletRoutes = require('./routes/wallet');
const webhookRoutes = require('./routes/webhooks');
const partnerBmiReportRoutes = require("./routes/partnerBmiReportRoutes");

const app = express();
const PORT = process.env.PORT || 4007;

// ─── Trust Proxy (required when behind Nginx/reverse proxy) ──────────────────
app.set('trust proxy', 1);

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS (React Native — allow all origins) ─────────────────────────────────
app.use(
  cors({
    origin: "*", // React Native doesn't send Origin headers — * is safe
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// ─── Request Logger ──────────────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ─── Body Parsers ─────────────────────────────────────────────────────────────
// ✅ Step 1: Webhook route gets its OWN JSON parser with rawBody capture
//    MUST be registered BEFORE the global express.json() below
//    Only this route pays the memory cost of storing rawBody
app.use(
  '/api/v1/webhooks/razorpay',
  express.json({
    verify: (req, res, buf) => {
      // Raw Buffer required for Razorpay HMAC-SHA256 signature verification
      req.rawBody = Buffer.from(buf);
    },
  }),
);

// ─── Body Parsers ────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─── Static Uploads ──────────────────────────────────────────────────────────
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ─── Global Rate Limiter ─────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 100, // max 100 requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please try again after 5 minutes.",
  },
});
app.use("/api/", globalLimiter);

// ─── Health Check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.status(200).send("MySehat App Backend is running!");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    app: "MySehat App Backend",
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/v1/webhooks', webhookRoutes);
app.use("/api/v1/wa-auth", waAuthRoutes);
app.use("/api/v1/members", memberRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/transactions", transactionRoutes);
app.use("/api/v1/orders", orderRoutes);
app.use("/api/v1", paymentRoutes);
app.use('/api/v1/partner-auth', partnerAuthRoutes);
app.use('/api/v1/partner', partnerRoutes);
app.use('/api/v1/machine-recharge', machineRechargeRoutes);
app.use('/api/v1/partner-wallet', partnerWalletRoutes); 
app.use('/api/v1/wallet', walletRoutes);
app.use("/api/v1/partner-bmi-reports", partnerBmiReportRoutes);

// ─── Start Server ────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`✅ Server runninggg on http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log("✅ HTTP server closed");
    process.exit(0);
  });

  // Force shutdown after 10s if not closed
  setTimeout(() => {
    console.error("⚠️ Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = app;
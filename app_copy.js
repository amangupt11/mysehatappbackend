// app.js
require('dotenv').config();
const express = require('express');
const path = require('path');

// Import Routes
const waAuthRoutes = require("./routes/waAuthRoutes");
const memberRoutes = require('./routes/members');
const reportRoutes = require('./routes/reports');
const transactionRoutes = require('./routes/transaction');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 4007;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// Static folder for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Use Routes
app.use("/api/v1", waAuthRoutes);
app.use('/api/v1', memberRoutes);
app.use('/api/v1', reportRoutes);
app.use('/api/v1', transactionRoutes);
app.use('/api/v1', orderRoutes);
app.use('/api/v1', paymentRoutes);

// Basic health check route
app.get('/', (req, res) => {
  res.status(200).send('MySehat App Backend is running!');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
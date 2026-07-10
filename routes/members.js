// routes/members.js
const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');
const { authenticateToken } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

// Protect all routes
router.use(authenticateToken);

// ─── Static routes FIRST (before /:id) ───────────────────────────────────────
router.get('/profile', memberController.getMyProfile);         // GET  /api/v1/members/profile
router.put('/profile', upload.single('profileImage'), memberController.updateProfile); // PUT  /api/v1/members/profile

// ─── Dynamic routes AFTER ────────────────────────────────────────────────────
router.get('/', memberController.getAllMembers);                // GET  /api/v1/members
router.post('/', memberController.createMember);               // POST /api/v1/members
router.get('/:id', memberController.getMemberById);            // GET  /api/v1/members/:id
router.put('/:id', memberController.updateMember);             // PUT  /api/v1/members/:id
router.delete('/:id', memberController.deleteMember);          // DELETE /api/v1/members/:id

module.exports = router;
// middleware/upload.js
// ✅ FIXED: Generates ONE random filename per user (never changes)

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // ✅ Create user-specific folder: /uploads/profiles/UID1225-000017/
    const userId = req.user.userId;
    const userUploadDir = path.join(__dirname, '../uploads/profiles', userId);
    
    // Create folder if it doesn't exist
    if (!fs.existsSync(userUploadDir)) {
      fs.mkdirSync(userUploadDir, { recursive: true });
      console.log('✅ Created user folder:', userUploadDir);
    }
    
    cb(null, userUploadDir);
  },
  
  filename: (req, file, cb) => {
    // ✅ Generate CONSISTENT random filename based on userId
    // Same userId = Same random filename always
    const userId = req.user.userId;
    const ext = path.extname(file.originalname);
    
    // Create hash from userId (always same for same user)
    const hash = crypto.createHash('md5').update(userId).digest('hex');
    
    // Take first 16 characters for filename
    const randomName = hash.substring(0, 16);
    const filename = `${randomName}${ext}`;
    
    console.log('📁 User:', userId);
    console.log('📄 Consistent random filename:', filename);
    console.log('ℹ️ This filename will ALWAYS be the same for this user');
    
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files are allowed'), false);
  }
  cb(null, true);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 9 * 1024 * 1024 } // 9MB
});
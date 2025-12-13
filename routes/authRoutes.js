const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getProfile,
  updateProfile,
  requestPasswordReset,
  confirmPasswordReset,
} = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');
const {
  registerValidator,
  loginValidator,
  passwordResetValidator,
  passwordResetConfirmValidator,
} = require('../utils/validators');

// Public routes
router.post('/register', registerValidator, register);
router.post('/login', loginValidator, login);
router.post('/forgot-password', passwordResetValidator, requestPasswordReset);
router.post('/reset-password', passwordResetConfirmValidator, confirmPasswordReset);

// Protected routes
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, upload.single('avatar'), updateProfile);

module.exports = router;


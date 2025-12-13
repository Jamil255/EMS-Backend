const express = require('express');
const router = express.Router();
const {
  submitLeaveRequest,
  getLeaveRequests,
  approveLeaveRequest,
  getLeaveBalance,
  getLeaveCalendar,
} = require('../controllers/leaveController');
const { authenticate, authorize } = require('../middleware/auth');
const { leaveRequestValidator, leaveApprovalValidator, idValidator } = require('../utils/validators');

// All routes require authentication
router.use(authenticate);

// Submit leave request
router.post('/request', leaveRequestValidator, submitLeaveRequest);

// Get leave requests
router.get('/requests', getLeaveRequests);

// Get leave balance
router.get('/balance', getLeaveBalance);

// Get leave calendar
router.get('/calendar', getLeaveCalendar);

// Approve/Reject leave request (Manager/Admin only)
router.put('/requests/:id/approve', authorize('admin', 'manager'), idValidator, leaveApprovalValidator, approveLeaveRequest);

module.exports = router;


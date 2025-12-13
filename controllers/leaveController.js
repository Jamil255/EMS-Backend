const pool = require('../config/database');

// Submit leave request
const submitLeaveRequest = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { leave_type, start_date, end_date, reason } = req.body;

    // Get employee_id
    const empResult = await pool.query('SELECT id FROM employees WHERE user_id = $1', [userId]);
    if (empResult.rows.length === 0) {
      return res.status(404).json({ message: 'Employee record not found' });
    }

    const employeeId = empResult.rows[0].id;

    // Calculate days (excluding weekends)
    const start = new Date(start_date);
    const end = new Date(end_date);
    let days = 0;
    const currentDate = new Date(start);

    while (currentDate <= end) {
      const dayOfWeek = currentDate.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        days++;
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (days <= 0) {
      return res.status(400).json({ message: 'Invalid date range' });
    }

    // Check leave balance
    const currentYear = new Date().getFullYear();
    const balanceResult = await pool.query(
      'SELECT * FROM leave_balances WHERE employee_id = $1 AND year = $2',
      [employeeId, currentYear]
    );

    if (balanceResult.rows.length === 0) {
      // Initialize leave balance
      await pool.query(
        'INSERT INTO leave_balances (employee_id, year) VALUES ($1, $2)',
        [employeeId, currentYear]
      );
    }

    const balance = balanceResult.rows[0] || {
      sick_leave: 10,
      vacation_leave: 20,
      personal_leave: 5,
      emergency_leave: 3,
    };

    const balanceField = `${leave_type}_leave`;
    if (balance[balanceField] < days) {
      return res.status(400).json({
        message: `Insufficient leave balance. Available: ${balance[balanceField]} days`,
      });
    }

    // Check for overlapping leave requests
    const overlapping = await pool.query(
      `SELECT id FROM leave_requests 
       WHERE employee_id = $1 
       AND status = 'pending'
       AND (
         (start_date <= $2 AND end_date >= $2) OR
         (start_date <= $3 AND end_date >= $3) OR
         (start_date >= $2 AND end_date <= $3)
       )`,
      [employeeId, start_date, end_date]
    );

    if (overlapping.rows.length > 0) {
      return res.status(400).json({ message: 'Overlapping leave request already exists' });
    }

    // Create leave request
    const result = await pool.query(
      'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days, reason) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [employeeId, leave_type, start_date, end_date, days, reason || null]
    );

    // Get employee name for notification
    const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const employeeName = userResult.rows[0]?.name || 'Employee';

    // Get all managers and admins to save notifications
    const managersResult = await pool.query(
      "SELECT id FROM users WHERE role IN ('admin', 'manager')"
    );

    // Save notification to database for each manager/admin
    const notificationData = {
      leaveRequestId: result.rows[0].id,
      employeeId,
      employeeName,
      leaveType: leave_type,
      startDate: start_date,
      endDate: end_date,
      days,
    };

    const notificationPromises = managersResult.rows.map(manager => 
      pool.query(
        `INSERT INTO notifications (user_id, type, title, message, data) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          manager.id,
          'leave_request',
          'New Leave Request',
          `${employeeName} requested ${days} day(s) of ${leave_type} leave`,
          JSON.stringify(notificationData)
        ]
      )
    );
    await Promise.all(notificationPromises);

    // Send real-time notification to managers and admins via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to('managers').emit('newLeaveRequest', {
        id: result.rows[0].id,
        employeeName,
        leaveType: leave_type,
        startDate: start_date,
        endDate: end_date,
        days,
        reason: reason || 'No reason provided',
        timestamp: new Date(),
      });
      console.log('Leave notification sent to managers');
    }

    res.status(201).json({
      message: 'Leave request submitted successfully',
      leave_request: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

// Get leave requests
const getLeaveRequests = async (req, res, next) => {
  try {
    const { employee_id, status, leave_type, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT lr.id, lr.leave_type, lr.start_date, lr.end_date, lr.days, lr.reason, 
             lr.status, lr.approved_by, lr.approved_at, lr.created_at,
             e.id as employee_id, e.employee_code,
             u.name as employee_name, u.email,
             approver.name as approver_name
      FROM leave_requests lr
      INNER JOIN employees e ON lr.employee_id = e.id
      INNER JOIN users u ON e.user_id = u.id
      LEFT JOIN users approver ON lr.approved_by = approver.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    // Role-based filtering
    if (req.user.role === 'employee') {
      const empResult = await pool.query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
      if (empResult.rows.length > 0) {
        query += ` AND lr.employee_id = $${paramCount}`;
        params.push(empResult.rows[0].id);
        paramCount++;
      }
    } else if (employee_id) {
      query += ` AND lr.employee_id = $${paramCount}`;
      params.push(employee_id);
      paramCount++;
    }

    if (status) {
      query += ` AND lr.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (leave_type) {
      query += ` AND lr.leave_type = $${paramCount}`;
      params.push(leave_type);
      paramCount++;
    }

    query += ` ORDER BY lr.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM leave_requests lr WHERE 1=1`;
    const countParams = [];
    let countParamCount = 1;

    if (req.user.role === 'employee') {
      const empResult = await pool.query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
      if (empResult.rows.length > 0) {
        countQuery += ` AND lr.employee_id = $${countParamCount}`;
        countParams.push(empResult.rows[0].id);
        countParamCount++;
      }
    } else if (employee_id) {
      countQuery += ` AND lr.employee_id = $${countParamCount}`;
      countParams.push(employee_id);
      countParamCount++;
    }

    if (status) {
      countQuery += ` AND lr.status = $${countParamCount}`;
      countParams.push(status);
      countParamCount++;
    }

    if (leave_type) {
      countQuery += ` AND lr.leave_type = $${countParamCount}`;
      countParams.push(leave_type);
      countParamCount++;
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    res.json({
      leaves: result.rows,
      leave_requests: result.rows, // For backward compatibility
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Approve/Reject leave request
const approveLeaveRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved or rejected' });
    }

    // Get leave request
    const leaveResult = await pool.query(
      'SELECT * FROM leave_requests WHERE id = $1',
      [id]
    );

    if (leaveResult.rows.length === 0) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    const leaveRequest = leaveResult.rows[0];

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({ message: 'Leave request has already been processed' });
    }

    await pool.query('BEGIN');

    try {
      // Update leave request
      await pool.query(
        'UPDATE leave_requests SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP WHERE id = $3',
        [status, req.user.id, id]
      );

      // If approved, deduct from leave balance
      if (status === 'approved') {
        const currentYear = new Date().getFullYear();
        
        // Validate leave_type and build column name safely
        const validLeaveTypes = ['sick', 'vacation', 'personal', 'emergency'];
        if (!validLeaveTypes.includes(leaveRequest.leave_type)) {
          throw new Error('Invalid leave type');
        }
        
        const balanceField = `${leaveRequest.leave_type}_leave`;
        
        // Check if leave balance exists, create if not
        const balanceCheck = await pool.query(
          'SELECT * FROM leave_balances WHERE employee_id = $1 AND year = $2',
          [leaveRequest.employee_id, currentYear]
        );
        
        if (balanceCheck.rows.length === 0) {
          await pool.query(
            'INSERT INTO leave_balances (employee_id, year) VALUES ($1, $2)',
            [leaveRequest.employee_id, currentYear]
          );
        }

        // Use parameterized query with safe column name
        const updateQuery = `UPDATE leave_balances 
           SET ${balanceField} = GREATEST(${balanceField} - $1, 0)
           WHERE employee_id = $2 AND year = $3`;
           
        await pool.query(updateQuery, [leaveRequest.days, leaveRequest.employee_id, currentYear]);
      }

      await pool.query('COMMIT');

      res.json({ message: `Leave request ${status} successfully` });
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

// Get leave balance
const getLeaveBalance = async (req, res, next) => {
  try {
    const userId = req.user.role === 'employee' ? req.user.id : null;
    const { employee_id, year } = req.query;

    let employeeId;

    if (req.user.role === 'employee') {
      const empResult = await pool.query('SELECT id FROM employees WHERE user_id = $1', [userId]);
      if (empResult.rows.length === 0) {
        return res.status(404).json({ message: 'Employee record not found' });
      }
      employeeId = empResult.rows[0].id;
    } else if (employee_id) {
      employeeId = employee_id;
    } else {
      return res.status(400).json({ message: 'Employee ID is required' });
    }

    const currentYear = year || new Date().getFullYear();

    const result = await pool.query(
      'SELECT * FROM leave_balances WHERE employee_id = $1 AND year = $2',
      [employeeId, currentYear]
    );

    if (result.rows.length === 0) {
      // Initialize if doesn't exist
      await pool.query(
        'INSERT INTO leave_balances (employee_id, year) VALUES ($1, $2) RETURNING *',
        [employeeId, currentYear]
      );
      const newResult = await pool.query(
        'SELECT * FROM leave_balances WHERE employee_id = $1 AND year = $2',
        [employeeId, currentYear]
      );
      return res.json(newResult.rows[0]);
    }

    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
};

// Get leave calendar
const getLeaveCalendar = async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const currentYear = year || new Date().getFullYear();
    const currentMonth = month || new Date().getMonth() + 1;

    let query = `
      SELECT lr.start_date, lr.end_date, lr.leave_type, lr.status,
             e.employee_code,
             u.name as employee_name
      FROM leave_requests lr
      INNER JOIN employees e ON lr.employee_id = e.id
      INNER JOIN users u ON e.user_id = u.id
      WHERE EXTRACT(YEAR FROM lr.start_date) = $1 
      AND EXTRACT(MONTH FROM lr.start_date) = $2
      AND lr.status = 'approved'
    `;

    const result = await pool.query(query, [currentYear, currentMonth]);

    res.json({
      year: currentYear,
      month: currentMonth,
      leaves: result.rows,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  submitLeaveRequest,
  getLeaveRequests,
  approveLeaveRequest,
  getLeaveBalance,
  getLeaveCalendar,
};


const pool = require('../config/database');

// Get notifications for logged-in user
const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { status = 'unread', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT id, type, title, message, data, status, created_at, read_at
      FROM notifications
      WHERE user_id = $1
    `;
    const params = [userId];
    let paramCount = 2;

    if (status && status !== 'all') {
      query += ` AND status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM notifications WHERE user_id = $1';
    const countParams = [userId];
    if (status && status !== 'all') {
      countQuery += ' AND status = $2';
      countParams.push(status);
    }
    const countResult = await pool.query(countQuery, countParams);

    // Get unread count
    const unreadResult = await pool.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND status = $2',
      [userId, 'unread']
    );

    res.json({
      notifications: result.rows,
      unreadCount: parseInt(unreadResult.rows[0].count),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        pages: Math.ceil(countResult.rows[0].total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Mark notification as read
const markAsRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE notifications 
       SET status = 'read', read_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND user_id = $2 
       RETURNING *`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({
      message: 'Notification marked as read',
      notification: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

// Mark all notifications as read
const markAllAsRead = async (req, res, next) => {
  try {
    const userId = req.user.id;

    await pool.query(
      `UPDATE notifications 
       SET status = 'read', read_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND status = 'unread'`,
      [userId]
    );

    res.json({
      message: 'All notifications marked as read',
    });
  } catch (error) {
    next(error);
  }
};

// Delete notification
const deleteNotification = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({
      message: 'Notification deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};

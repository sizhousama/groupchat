const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ? [
            "https://your-domain.netlify.app",
            "https://your-custom-domain.com"
        ] : "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 数据库初始化
const db = new sqlite3.Database('chat.db', (err) => {
    if (err) {
        console.error('数据库连接错误:', err);
    } else {
        console.log('数据库连接成功');
        initDatabase();
    }
});

// 初始化数据库表
function initDatabase() {
    // 创建用户表
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME
        )
    `, (err) => {
        if (err) {
            console.error('创建用户表失败:', err);
        } else {
            console.log('用户表创建成功');
            // 创建默认用户用于测试
            createDefaultUsers();
        }
    });

    // 创建消息表
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            user_name TEXT,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES users (student_id)
        )
    `, (err) => {
        if (err) {
            console.error('创建消息表失败:', err);
        } else {
            console.log('消息表创建成功');
        }
    });

    // 创建在线用户表（内存表，重启会清空）
    db.run(`
        CREATE TABLE IF NOT EXISTS online_users (
            student_id TEXT PRIMARY KEY,
            user_name TEXT,
            socket_id TEXT,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('创建在线用户表失败:', err);
        } else {
            console.log('在线用户表创建成功');
        }
    });
}

// 创建默认测试用户
function createDefaultUsers() {
    const defaultUsers = [
        { studentId: '2021001', password: '123456', name: '张三' },
        { studentId: '2021002', password: '123456', name: '李四' },
        { studentId: '2021003', password: '123456', name: '王五' },
        { studentId: '2021004', password: '123456', name: '赵六' }
    ];

    defaultUsers.forEach(user => {
        const hashedPassword = bcrypt.hashSync(user.password, 10);
        db.run(
            `INSERT OR IGNORE INTO users (student_id, password, name) VALUES (?, ?, ?)`,
            [user.studentId, hashedPassword, user.name],
            function(err) {
                if (err) {
                    console.error(`创建用户 ${user.studentId} 失败:`, err);
                } else if (this.changes > 0) {
                    console.log(`创建默认用户: ${user.studentId} (${user.name})`);
                }
            }
        );
    });
}

// 存储连接的用户
const connectedUsers = new Map();

// 路由配置

// 根路径重定向到登录页
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// 确保直接访问聊天页面时检查登录状态
app.get('/chat.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// API 路由

// 用户登录
app.post('/api/login', (req, res) => {
    const { studentId, password } = req.body;

    if (!studentId || !password) {
        return res.status(400).json({
            success: false,
            message: '学号和密码不能为空'
        });
    }

    db.get(
        'SELECT * FROM users WHERE student_id = ?',
        [studentId],
        (err, user) => {
            if (err) {
                console.error('数据库查询错误:', err);
                return res.status(500).json({
                    success: false,
                    message: '服务器内部错误'
                });
            }

            if (!user) {
                return res.status(401).json({
                    success: false,
                    message: '学号不存在'
                });
            }

            // 验证密码
            if (!bcrypt.compareSync(password, user.password)) {
                return res.status(401).json({
                    success: false,
                    message: '密码错误'
                });
            }

            // 更新最后登录时间
            db.run(
                'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE student_id = ?',
                [studentId]
            );

            res.json({
                success: true,
                message: '登录成功',
                user: {
                    studentId: user.student_id,
                    name: user.name
                }
            });
        }
    );
});

// 获取历史消息
app.get('/api/messages', (req, res) => {
    const { days, startDate, endDate } = req.query;
    let query = 'SELECT * FROM messages';
    const params = [];

    if (days && days !== '0') {
        query += ` WHERE timestamp >= datetime('now', '-${parseInt(days)} days')`;
    } else if (startDate && endDate) {
        query += ` WHERE date(timestamp) BETWEEN ? AND ?`;
        params.push(startDate, endDate);
    } else if (startDate) {
        query += ` WHERE date(timestamp) >= ?`;
        params.push(startDate);
    }

    query += ' ORDER BY timestamp ASC LIMIT 1000';

    db.all(query, params, (err, messages) => {
        if (err) {
            console.error('获取消息失败:', err);
            return res.status(500).json({
                success: false,
                message: '获取消息失败'
            });
        }

        const formattedMessages = messages.map(msg => ({
            id: msg.id,
            content: msg.content,
            timestamp: msg.timestamp,
            user: {
                studentId: msg.student_id,
                name: msg.user_name
            }
        }));

        res.json({
            success: true,
            messages: formattedMessages
        });
    });
});

// Socket.IO 连接处理
io.on('connection', (socket) => {
    console.log(`用户连接: ${socket.id}`);

    // 用户加入聊天室
    socket.on('join', (userInfo) => {
        const { studentId, name } = userInfo;
        
        // 保存用户信息
        connectedUsers.set(socket.id, { studentId, name, socketId: socket.id });
        
        // 添加到数据库在线用户表
        db.run(
            'INSERT OR REPLACE INTO online_users (student_id, user_name, socket_id) VALUES (?, ?, ?)',
            [studentId, name, socket.id]
        );

        console.log(`${name || studentId} 加入聊天室`);

        // 广播用户加入信息
        socket.broadcast.emit('userJoined', {
            user: { studentId, name }
        });

        // 发送当前在线用户列表
        updateUserList();

        // 发送欢迎消息
        socket.emit('systemMessage', {
            type: 'welcome',
            message: '欢迎来到群聊！'
        });
    });

    // 发送消息
    socket.on('sendMessage', (messageData) => {
        const { content, user } = messageData;
        const timestamp = new Date().toISOString();

        // 保存消息到数据库
        db.run(
            'INSERT INTO messages (student_id, user_name, content, timestamp) VALUES (?, ?, ?, ?)',
            [user.studentId, user.name, content, timestamp],
            function(err) {
                if (err) {
                    console.error('保存消息失败:', err);
                    socket.emit('error', { message: '消息发送失败' });
                    return;
                }

                const message = {
                    id: this.lastID,
                    content,
                    timestamp,
                    user: {
                        studentId: user.studentId,
                        name: user.name
                    }
                };

                // 广播消息给所有连接的客户端
                io.emit('newMessage', message);
                console.log(`${user.name || user.studentId}: ${content}`);
            }
        );
    });

    // 获取消息历史
    socket.on('getMessages', (dateRange) => {
        let query = 'SELECT * FROM messages';
        const params = [];

        if (dateRange.days && dateRange.days !== 0) {
            query += ` WHERE timestamp >= datetime('now', '-${dateRange.days} days')`;
        } else if (dateRange.startDate && dateRange.endDate) {
            query += ` WHERE date(timestamp) BETWEEN ? AND ?`;
            params.push(dateRange.startDate, dateRange.endDate);
        } else if (dateRange.startDate) {
            query += ` WHERE date(timestamp) >= ?`;
            params.push(dateRange.startDate);
        }

        query += ' ORDER BY timestamp ASC LIMIT 1000';

        db.all(query, params, (err, messages) => {
            if (err) {
                console.error('获取消息历史失败:', err);
                socket.emit('error', { message: '获取消息历史失败' });
                return;
            }

            const formattedMessages = messages.map(msg => ({
                id: msg.id,
                content: msg.content,
                timestamp: msg.timestamp,
                user: {
                    studentId: msg.student_id,
                    name: msg.user_name
                }
            }));

            socket.emit('messageHistory', formattedMessages);
        });
    });

    // 用户断开连接
    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            console.log(`${user.name || user.studentId} 离开聊天室`);
            
            // 从在线用户表中移除
            db.run('DELETE FROM online_users WHERE socket_id = ?', [socket.id]);
            
            // 从内存中移除
            connectedUsers.delete(socket.id);
            
            // 广播用户离开信息
            socket.broadcast.emit('userLeft', {
                user: { studentId: user.studentId, name: user.name }
            });

            // 更新在线用户列表
            updateUserList();
        }
    });

    // 更新在线用户列表
    function updateUserList() {
        db.all('SELECT * FROM online_users ORDER BY joined_at ASC', [], (err, users) => {
            if (err) {
                console.error('获取在线用户失败:', err);
                return;
            }

            const userList = users.map(user => ({
                studentId: user.student_id,
                name: user.user_name,
                online: true
            }));

            io.emit('userListUpdate', userList);
        });
    }
});

// 获取本机IP地址
function getLocalIP() {
    const interfaces = require('os').networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '127.0.0.1';
}

// 启动服务器，监听所有网络接口
server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('🚀 群聊系统服务器启动成功！');
    console.log('='.repeat(50));
    console.log(`📍 端口: ${PORT}`);
    console.log(`🏠 本机访问: http://localhost:${PORT}`);
    console.log(`🌐 局域网访问: http://${localIP}:${PORT}`);
    console.log('='.repeat(50));
    console.log('📱 局域网内其他设备可通过以下方式访问：');
    console.log(`   电脑/手机浏览器输入: http://${localIP}:${PORT}`);
    console.log('='.repeat(50));
    console.log('💡 如果局域网访问失败，请检查Windows防火墙设置');
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    db.close((err) => {
        if (err) {
            console.error('关闭数据库连接失败:', err);
        } else {
            console.log('数据库连接已关闭');
        }
        process.exit(0);
    });
});

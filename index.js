import { createServer } from 'http';
import { Server } from 'socket.io';
import  express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import * as jose from 'jose';


const db =  await open({
  filename: './chat.db',
  driver: sqlite3.Database
})

await db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  socketId TEXT,
  token TEXT,
  isOnline INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  other_user_id INTEGER,
  message TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
  FOREIGN KEY(other_user_id) REFERENCES users(id)
);`);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: 'http://localhost:4200',
    methods: ['GET', 'POST'],
  }
})

app.use(cors({ origin: 'http://localhost:4200' }));
app.use(express.json());
app.post('/subscribe', async (req, res) => {
  await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [req.body.username, req.body.password]);
  res.status(201).send({ message: 'User registered successfully', isSubcribed: true });
});



io.use(async (socket, next) => {
    const username = socket.handshake.auth.username;
    const password = socket.handshake.auth.password;
    const isAuthenticated = socket.handshake.auth.isAuthenticated;
    const userId = socket.handshake.auth.userId;
    const userToken = null || socket.handshake.auth.token;

    let tokenIsValid = await jose.jwtVerify(userToken, new TextEncoder().encode('chat_application_secret_key')).then(()=> true).catch((err) => {
      return false;
    });

    // let tokenIsValid = userToken && userToken.code !== 'ERR_JWT_EXPIRED' ? await jose.jwtVerify(userToken, new TextEncoder().encode('chat_application_secret_key')) : false;

    let user = await db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
    if(user?.id){
      let token = await new jose.SignJWT({ username: user.username })
          .setProtectedHeader({ alg: 'HS256' })
          .setExpirationTime('1h')
          .sign(new TextEncoder().encode('chat_application_secret_key'));
          
       socket.handshake.auth.token = token;
       socket.handshake.auth.userId = user.id;
       tokenIsValid = true;
    }
    if(userId) {

      await db.run('UPDATE users SET socketId = ? WHERE id = ?', [socket.id, userId]);
      
      if(!tokenIsValid) {
        socket.emit('user_disconnected', user);
        return next(new Error('authentication error'));
      }
    }

    if (user && (username === user.username && password === user.password) || isAuthenticated && tokenIsValid) {
      await db.run('UPDATE users SET socketId = ? WHERE id = ?', [socket.id, user?.id]);
      await db.run('UPDATE users SET isOnline = 1 WHERE id = ?', [user?.id]);
    //  let messages =  await db.run('SELECT * FROM messages WHERE user_id = ?', [user?.id]);
      
      next();
    } else {
      return next(new Error('authentication error'));
    }
  });

io.on('connection',async (socket) => {
  let users = await db.all('SELECT id, username, isOnline, socketId FROM users');
  let user = await db.get('SELECT id, username, isOnline, socketId FROM users WHERE id = ?', [socket.handshake.auth.userId]);
  let userToken = socket.handshake.auth.token;
  user.token = userToken;
  let tokenIsValid = await jose.jwtVerify(userToken, new TextEncoder().encode('chat_application_secret_key'));
  socket.on('get_users', ()=>{
    socket.emit('users', users);
  });
  
  socket.emit('user', user);
  socket.broadcast.emit('user_connected', user);

  if(tokenIsValid){
    socket.on('private message', async (content) => {   
    await db.run('INSERT INTO messages (user_id, other_user_id, message) VALUES (?, ?, ?)', [socket.handshake.auth.userId, content.otherUserId, content.content]);
    let fullMessage = {
      user_id: socket.handshake.auth.userId,
      message: content.content,
      timestamp: new Date().toISOString()
    };

    socket.to(content.to).emit('private message', {fullMessage, from: socket.id});
  });

    socket.on('webrtc_offer', (data) => {
      socket.to(data.to).emit('webrtc_offer', {
        sdp: data.sdp,
        from: user.socketId
      });
    });

    socket.on('webrtc_answer', (data) => {
      socket.to(data.to).emit('webrtc_answer', {
        sdp: data.sdp,
        from: user.socketId
      });
    });

    socket.on('webrtc_ice_candidate', (data) => {
      socket.to(data.to).emit('webrtc_ice_candidate', {
        candidate: data.candidate,
        from: user.socketId
      });
    });

    socket.on('webrtc_pick_call', (data) => {
      socket.to(data.to).emit('webrtc_pick_call', {
        pick: data.pick,
        from: user.socketId
      });
    });

    socket.on('webrtc_hang_up', (data) => {
      socket.to(data.to).emit('webrtc_hang_up', {
        from: user.socketId
      });
    });

  socket.on('messages', async (user) => {
    const messages = await db.all('SELECT * FROM messages WHERE (user_id = ? AND other_user_id = ?) OR (user_id = ? AND other_user_id = ?)', [user?.id, user?.otherUserId, user?.otherUserId, user?.id]);
    // console.log(messages);
    
    socket.emit('messages', messages);
  })
  }

  socket.on('user_disconnecting', async () => {
    await db.run('UPDATE users SET isOnline = 0 WHERE socketId = ?', [socket.id]);
    let user = await db.get('SELECT id, username, isOnline, socketId FROM users WHERE socketId = ?', [socket.id]);
    socket.handshake.auth.isAuthenticated = null;
    socket.handshake.auth.userId = null;
    socket.handshake.auth.token = null;
    socket.broadcast.emit('other_user_disconnected', user);
    socket.emit('user_disconnected', user);
  });

  socket.on('disconnect', async () => {
    console.log("Socket fermée :", socket.id);
  });
});

httpServer.listen(3000, () => {
  console.log('Server is listening on port 3000');
});


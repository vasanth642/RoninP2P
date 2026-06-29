const express = require('express');
const {Server} = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
  cors: {
    origin: "*",
    methods: ["GET","POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room: ${roomId}`);

    socket.to(roomId).emit('peer-joined',socket.id);
  });

  //Relay SDP Blueprint
  socket.on('sdp-signal', ({ roomId, sdp }) => {
    socket.to(roomId).emit('sdp-signal', sdp);
  });

  // Relay STUN Coordinates
  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', candidate);
  });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`RoninMesh signaling Server running on port ${PORT}`);
});